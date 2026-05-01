// ─────────────────────────────────────────────────────────────────────────────
// NATS JetStream Gateway → Temporal Workflow
//
// 責務:
//   1. JetStream ストリーム / 耐久コンシューマーを冪等に作成
//   2. メッセージを PlatformRequest にデシリアライズ
//   3. Temporal ワークフローを起動 (workflowId = "platform-{requestId}")
//   4. 成功 → ack  失敗 → nak (JetStream が max_deliver まで再配送)
//   5. 不正形式のメッセージは DLQ subject へ転送して ack
// ─────────────────────────────────────────────────────────────────────────────
import {
  connect,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
} from 'nats';
import { Connection, WorkflowClient } from '@temporalio/client';
import { SpanStatusCode }              from '@opentelemetry/api';
import { getTracer }                   from './telemetry.ts';
import { platformWorkflow } from './workflows/platformWorkflow.ts';
import {
  natsMessagesReceivedTotal,
  natsMessagesAckedTotal,
  natsMessagesNakTotal,
  natsDlqTotal,
  workflowStartedTotal,
} from './metrics.ts';
import type { Config }          from './config.ts';
import type { Logger }          from './logger.ts';
import type { PlatformRequest } from './types.ts';

export async function startGateway(
  config: Config,
  logger: Logger,
  shutdownSignal: AbortSignal,
): Promise<void> {
  const log = logger.child({ component: 'gateway' });

  // ── NATS 接続 ─────────────────────────────────────────────────────────
  const nc = await connect({ servers: config.nats.servers });
  log.info('Connected to NATS', { servers: config.nats.servers });

  // ── Temporal クライアント接続 ──────────────────────────────────────────
  const temporalConn = await Connection.connect({ address: config.temporal.address });
  const client = new WorkflowClient({
    connection: temporalConn,
    namespace:  config.temporal.namespace,
  });
  log.info('Connected to Temporal', { address: config.temporal.address });

  const jsm = await nc.jetstreamManager();

  // ── JetStream ストリームを冪等に作成 ──────────────────────────────────
  try {
    await jsm.streams.add({
      name:      config.nats.streamName,
      subjects:  config.nats.subjects,
      retention: RetentionPolicy.Workqueue,
      // 24 時間 (ナノ秒)
      max_age:   24 * 60 * 60 * 1_000_000_000,
      max_msgs:  1_000_000,
      // 重複排除ウィンドウ (2 分)
      duplicate_window: 2 * 60 * 1_000_000_000,
    });
    log.info('JetStream stream created', { stream: config.nats.streamName });
  } catch {
    log.info('JetStream stream already exists (or updated)', { stream: config.nats.streamName });
  }

  // ── DLQ JetStream ストリームを冪等に作成 ─────────────────────────────
  // DLQ コンシューマーが起動していない間もメッセージを保持するために JetStream を使用
  try {
    await jsm.streams.add({
      name:     config.nats.dlqStreamName,
      subjects: [config.nats.dlqSubject],
      // DLQ メッセージは 7 日間保持して手動調査・再処理に利用
      max_age:  7 * 24 * 60 * 60 * 1_000_000_000,
      max_msgs: 100_000,
    });
    log.info('DLQ JetStream stream created', { stream: config.nats.dlqStreamName });
  } catch {
    log.info('DLQ JetStream stream already exists', { stream: config.nats.dlqStreamName });
  }

  // ── 耐久コンシューマーを冪等に作成 ──────────────────────────────────
  try {
    await jsm.consumers.add(config.nats.streamName, {
      durable_name:   config.nats.consumerName,
      ack_policy:     AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      max_deliver:    config.nats.maxDeliver,
      // ack_wait: ナノ秒
      ack_wait:       config.nats.ackWaitSeconds * 1_000_000_000,
    });
    log.info('JetStream consumer created', { consumer: config.nats.consumerName });
  } catch {
    log.info('JetStream consumer already exists', { consumer: config.nats.consumerName });
  }

  const js       = nc.jetstream();
  const consumer = await js.consumers.get(config.nats.streamName, config.nats.consumerName);
  const messages = await consumer.consume();
  const sc       = StringCodec();

  log.info('Gateway listening for platform events');

  // シャットダウン時にコンシューマーを停止
  shutdownSignal.addEventListener('abort', () => {
    log.info('Gateway shutdown: stopping message consumer');
    messages.stop();
  }, { once: true });

  // ── メッセージ処理ループ ──────────────────────────────────────────────
  const tracer = getTracer('platform.gateway');

  for await (const msg of messages) {
    const msgLog = log.child({ subject: msg.subject, seq: msg.seq });

    // ── デシリアライズ ────────────────────────────────────────────────
    let request: PlatformRequest;
    try {
      request = JSON.parse(sc.decode(msg.data)) as PlatformRequest;

      if (!request.requestId || !request.tenantId || !request.userId) {
        throw new Error('Missing required fields: requestId, tenantId, userId');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      msgLog.error('Malformed message, sending to DLQ', { errMsg });
      // 不正形式のメッセージは DLQ JetStream に転送して ack (リトライしない)
      try {
        await js.publish(config.nats.dlqSubject, msg.data);
      } catch (dlqErr) {
        msgLog.error('Failed to publish to DLQ stream', { err: String(dlqErr) });
      }
      natsDlqTotal.inc();
      msg.ack();
      continue;
    }

    const reqLog = msgLog.child({ requestId: request.requestId, action: request.action });
    reqLog.info('Received platform event');
    natsMessagesReceivedTotal.inc({ subject: msg.subject });

    // ── Temporal ワークフロー起動 (スパン計装) ────────────────────────
    await tracer.startActiveSpan('nats.message.process', async (span) => {
      span.setAttributes({
        'messaging.system':           'nats',
        'messaging.destination':      msg.subject,
        'messaging.message.sequence': msg.seq,
        'platform.request_id':        request.requestId,
        'platform.tenant_id':         request.tenantId,
        'platform.action':            request.action,
        'platform.resource':          request.resource,
      });

      try {
        const handle = await client.start(platformWorkflow, {
          args:       [request],
          taskQueue:  config.temporal.taskQueue,
          // requestId をワークフロー ID に使うことで冪等性を保証
          workflowId: `platform-${request.requestId}`,
        });

        reqLog.info('Workflow started', { workflowId: handle.workflowId });
        workflowStartedTotal.inc({ task_queue: config.temporal.taskQueue });
        natsMessagesAckedTotal.inc();
        span.setAttribute('temporal.workflow_id', handle.workflowId);
        span.setStatus({ code: SpanStatusCode.OK });
        msg.ack();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // ワークフローが既に起動済み → 冪等 ack
        if (
          errMsg.includes('already started') ||
          errMsg.includes('already exists')  ||
          errMsg.includes('WorkflowExecutionAlreadyStarted')
        ) {
          reqLog.warn('Duplicate request — workflow already running, acking', { errMsg });
          natsMessagesAckedTotal.inc();
          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('gateway.duplicate', true);
          msg.ack();
        } else {
          reqLog.error('Failed to start workflow, will retry', { errMsg });
          natsMessagesNakTotal.inc();
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
          // JetStream が ackWait 後に再配送する
          msg.nak(5_000); // 5 秒後に再配送をリクエスト
        }
      }

      span.end();
    });
  }

  // ── クリーンアップ ────────────────────────────────────────────────────
  await nc.drain();
  await temporalConn.close();
  log.info('Gateway stopped');
}
