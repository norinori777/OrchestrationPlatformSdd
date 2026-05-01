// ─────────────────────────────────────────────────────────────────────────────
// DLQ (Dead Letter Queue) コンシューマー
//
// 責務:
//   1. PLATFORM-DLQ JetStream ストリームを冪等に作成 (7 日間保持)
//   2. 耐久コンシューマー "dlq-processor" でメッセージを順次処理
//   3. 各 DLQ メッセージに対して:
//      a. JSON パース試行 → 構造化ログ出力
//      b. Prometheus メトリクスインクリメント
//      c. NOTIFICATION_WEBHOOK_URL が設定されていれば Webhook アラート送信
//      d. OpenTelemetry スパン記録
//   4. 処理後に ack / エラー時は nak (JetStream が再配送)
//
// 起動: index.ts の Promise.all に追加して Gateway・Worker と並行実行
// ─────────────────────────────────────────────────────────────────────────────
import {
  connect,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
} from 'nats';
import { SpanStatusCode } from '@opentelemetry/api';
import { getTracer }      from './telemetry.ts';
import { dlqProcessedTotal, dlqAlertSentTotal } from './metrics.ts';
import type { Config }  from './config.ts';
import type { Logger }  from './logger.ts';

const DLQ_CONSUMER_NAME = 'dlq-processor';

export async function startDlqConsumer(
  config: Config,
  logger: Logger,
  shutdownSignal: AbortSignal,
): Promise<void> {
  const log    = logger.child({ component: 'dlqConsumer' });
  const tracer = getTracer('platform.dlq');
  const sc     = StringCodec();

  // ── NATS 接続 ─────────────────────────────────────────────────────────
  const nc = await connect({ servers: config.nats.servers });
  log.info('DLQ Consumer: connected to NATS', { servers: config.nats.servers });

  const jsm = await nc.jetstreamManager();

  // ── DLQ JetStream ストリームを冪等に作成 ──────────────────────────────
  // Gateway も同じストリームを作成するが、どちらが先に起動しても問題ない
  try {
    await jsm.streams.add({
      name:     config.nats.dlqStreamName,
      subjects: [config.nats.dlqSubject],
      // 7 日間保持: 手動調査・再処理のバッファ
      max_age:  7 * 24 * 60 * 60 * 1_000_000_000,
      max_msgs: 100_000,
    });
    log.info('DLQ stream ensured', { stream: config.nats.dlqStreamName });
  } catch {
    log.info('DLQ stream already exists', { stream: config.nats.dlqStreamName });
  }

  // ── 耐久コンシューマーを冪等に作成 ──────────────────────────────────
  try {
    await jsm.consumers.add(config.nats.dlqStreamName, {
      durable_name:   DLQ_CONSUMER_NAME,
      ack_policy:     AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
    });
    log.info('DLQ consumer ensured', { consumer: DLQ_CONSUMER_NAME });
  } catch {
    log.info('DLQ consumer already exists', { consumer: DLQ_CONSUMER_NAME });
  }

  const js       = nc.jetstream();
  const consumer = await js.consumers.get(config.nats.dlqStreamName, DLQ_CONSUMER_NAME);
  const messages = await consumer.consume();

  // ── シャットダウン時にコンシューマーを停止 ───────────────────────────
  shutdownSignal.addEventListener('abort', () => {
    log.info('DLQ Consumer: stopping message loop');
    messages.stop();
  }, { once: true });

  log.info('DLQ Consumer listening', {
    stream:   config.nats.dlqStreamName,
    subject:  config.nats.dlqSubject,
    consumer: DLQ_CONSUMER_NAME,
  });

  // ── メッセージ処理ループ ──────────────────────────────────────────────
  for await (const msg of messages) {
    await tracer.startActiveSpan('nats.dlq.process', async (span) => {
      span.setAttributes({
        'messaging.system':           'nats',
        'messaging.destination':      msg.subject,
        'messaging.message.sequence': msg.seq,
        'dlq.stream':                 config.nats.dlqStreamName,
      });

      try {
        const rawText = sc.decode(msg.data);

        // JSON パース試行 — 不正 JSON でもメタ情報はログに残す
        let parsed: unknown = null;
        let parseError = '';
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          parseError = 'Invalid JSON';
          parsed     = { raw: rawText.slice(0, 512) }; // 先頭 512 文字のみ
        }

        const dlqEntry = {
          seq:        msg.seq,
          subject:    msg.subject,
          timestamp:  new Date().toISOString(),
          parseError: parseError || undefined,
          payload:    parsed,
        };

        log.warn('DLQ message received', dlqEntry);
        dlqProcessedTotal.inc();

        span.setAttributes({
          'dlq.parse_error': parseError || 'none',
          'dlq.seq':         msg.seq,
        });

        // ── Webhook アラート (設定されている場合) ─────────────────────────
        if (config.notification.webhookUrl) {
          let alertResult: 'success' | 'failure' | 'error' = 'error';
          try {
            const alertBody = JSON.stringify({
              type:      'dlq_alert',
              service:   config.otel.serviceName,
              ...dlqEntry,
            });
            const res = await fetch(config.notification.webhookUrl, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    alertBody,
              signal:  AbortSignal.timeout(config.notification.webhookTimeoutMs),
            });
            span.setAttribute('dlq.alert.status_code', res.status);
            alertResult = res.ok ? 'success' : 'failure';
            if (!res.ok) {
              log.warn('DLQ webhook alert failed', { httpStatus: res.status });
            } else {
              log.info('DLQ webhook alert sent');
            }
          } catch (alertErr: unknown) {
            log.warn('DLQ webhook alert error (ignored)', { err: String(alertErr) });
          }
          dlqAlertSentTotal.inc({ result: alertResult });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        msg.ack();
      } catch (err: unknown) {
        span.recordException(err as Error);
        span.setStatus({
          code:    SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        log.error('DLQ message processing error', { err: String(err), seq: msg.seq });
        // 処理失敗時は nak — JetStream が再配送する
        msg.nak();
      } finally {
        span.end();
      }
    });
  }

  await nc.drain();
  log.info('DLQ Consumer stopped');
}
