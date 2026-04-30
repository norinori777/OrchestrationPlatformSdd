// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーションプラットフォーム — メインエントリポイント
//
// 起動順:
//   1. 設定・ロガー初期化
//   2. ヘルスサーバー起動 (:3000)
//   3. Temporal ワーカー生成
//   4. NATS JetStream ゲートウェイ起動
//   5. SIGTERM / SIGINT で graceful shutdown
//
// 実行:
//   npx ts-node src/product/index.ts
// ─────────────────────────────────────────────────────────────────────────────
import { loadConfig }         from './config.ts';
import { createLogger }       from './logger.ts';
import { startWorker }        from './worker.ts';
import { startGateway }       from './gateway.ts';
import { startHealthServer }  from './healthServer.ts';

async function main(): Promise<void> {
  // ── 設定 / ロガー ─────────────────────────────────────────────────────
  const config = loadConfig();
  const logger = createLogger(config.log.level, config.log.service);
  const log    = logger.child({ component: 'main' });

  log.info('Orchestration platform starting', {
    temporal:  config.temporal.address,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    nats:      config.nats.servers,
    opa:       config.opa.baseUrl,
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

  // ── ヘルスサーバー ───────────────────────────────────────────────────
  const closeHealth = startHealthServer({
    port:   config.health.port,
    host:   config.health.host,
    checks: {
      // OPA の疎通確認
      opa: async () => {
        const { default: fetch } = await import('node-fetch');
        const res = await fetch(`${config.opa.baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000) as unknown as Parameters<typeof fetch>[1] extends { signal?: infer S } ? S : never,
        });
        return res.ok;
      },
    },
  }, logger);

  // ── Temporal ワーカー ─────────────────────────────────────────────────
  const worker = await startWorker(config, logger);

  // シャットダウン時にワーカーも停止
  shutdownCtrl.signal.addEventListener('abort', () => {
    log.info('Shutting down Temporal worker...');
    void worker.shutdown();
  }, { once: true });

  // ── ワーカー + ゲートウェイを並行実行 ────────────────────────────────
  try {
    await Promise.all([
      worker.run().then(() => log.info('Worker finished')),
      startGateway(config, logger, shutdownCtrl.signal),
    ]);
  } finally {
    closeHealth();
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
