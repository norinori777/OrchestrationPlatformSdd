// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーションプラットフォーム — メインエントリポイント
//
// 起動順:
//   1. 設定・ロガー初期化
//   2. OpenTelemetry 初期化
//   3. ヘルスサーバー / メトリクスサーバー起動
//   4. Redis クライアント接続
//   5. 通知用 NATS 接続 (Worker → notificationActivity で使用)
//   6. Temporal ワーカー生成
//   7. NATS JetStream ゲートウェイ起動
//   8. DLQ コンシューマー起動
//   9. SIGTERM / SIGINT で graceful shutdown
//
// 実行:
//   npx ts-node src/product/index.ts
// ─────────────────────────────────────────────────────────────────────────────
import { connect }             from 'nats';
import { loadConfig }         from './config.ts';
import { createLogger }       from './logger.ts';
import { startWorker }        from './worker.ts';
import { startGateway }       from './gateway.ts';
import { startDlqConsumer }   from './dlqConsumer.ts';
import { startHealthServer }  from './healthServer.ts';
import { startMetricsServer } from './metricsServer.ts';
import { createRedisClient }  from './cache.ts';
import { initTelemetry, shutdownTelemetry } from './telemetry.ts';

async function main(): Promise<void> {
  // ── 設定 / ロガー ─────────────────────────────────────────────────────
  const config = loadConfig();
  const logger = createLogger(config.log.level, config.log.service);
  const log    = logger.child({ component: 'main' });
  // ── OpenTelemetry 初期化 (トレース他の初期化より前) ─────────────────
  initTelemetry(config.otel);
  log.info('OpenTelemetry initialized', {
    enabled:  config.otel.enabled,
    endpoint: config.otel.otlpEndpoint,
  });
  log.info('Orchestration platform starting', {
    temporal:  config.temporal.address,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    nats:      config.nats.servers,
    opa:       config.opa.baseUrl,
    redis:     config.redis.url,
    metrics:   `${config.metrics.host}:${config.metrics.port}`,
  });

  // ── Graceful shutdown ────────────────────────────────────────────────
  const shutdownCtrl = new AbortController();
  let   shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutdown initiated', { signal });
    shutdownCtrl.abort();
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT',  () => shutdown('SIGINT'));

  // ── Redis クライアント ──────────────────────────────────────────
  const redis = createRedisClient(config.redis.url);
  redis.on('connect', () => log.info('Redis connected'));
  redis.on('error',   (err: Error) => log.error('Redis error', { msg: err.message }));
  // ── 通知用 NATS 接続 (Worker 内の notificationActivity が使用) ───────
  const notifNc = await connect({ servers: config.nats.servers });
  log.info('Notification NATS connected', { servers: config.nats.servers });

  // ── メトリクスサーバー (/metrics エンドポイント) ───────────────────
  const closeMetrics = startMetricsServer(config.metrics.port, config.metrics.host, logger);

  // ── ヘルスサーバー ───────────────────────────────────────────────────
  const closeHealth = startHealthServer({
    port:   config.health.port,
    host:   config.health.host,
    checks: {
      // OPA の疎通確認
      opa: async () => {
        const res = await fetch(`${config.opa.baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        return res.ok;
      },
      // Redis PING
      redis: async () => {
        const pong = await redis.ping();
        return pong === 'PONG';
      },
      // NATS 接続確認
      nats: async () => !notifNc.isClosed(),
      // Temporal gRPC 疎通確認
      temporal: async () => {
        const { Connection } = await import('@temporalio/client');
        const conn = await Connection.connect({ address: config.temporal.address });
        try {
          await conn.workflowService.getSystemInfo({});
          return true;
        } finally {
          await conn.close();
        }
      },
    },
  }, logger);

  // ── Temporal ワーカー ─────────────────────────────────────────────────
  const worker = await startWorker(config, logger, redis, notifNc);

  // シャットダウン時にワーカーも停止
  shutdownCtrl.signal.addEventListener('abort', () => {
    log.info('Shutting down Temporal worker...');
    void worker.shutdown();
  }, { once: true });

  // ── ワーカー + ゲートウェイ + DLQ コンシューマーを並行実行 ───────────
  try {
    await Promise.all([
      worker.run().then(() => log.info('Worker finished')),
      startGateway(config, logger, shutdownCtrl.signal),
      startDlqConsumer(config, logger, shutdownCtrl.signal),
    ]);
  } finally {
    closeMetrics();
    closeHealth();
    await redis.quit().catch(() => { /* ignore */ });
    await notifNc.drain().catch(() => { /* ignore */ });
    await shutdownTelemetry();
    log.info('Platform stopped');
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({
      ts:    new Date().toISOString(),
      level: 'error',
      msg:   'Fatal startup error',
      err:   msg,
    }) + '\n',
  );
  process.exit(1);
});
