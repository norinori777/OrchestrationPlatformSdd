// ─────────────────────────────────────────────────────────────────────────────
// Prometheus メトリクス HTTP サーバー
//
// エンドポイント:
//   GET /metrics  → prom-client のテキスト形式 (Prometheus スクレイプ用)
//
// ポート: config.metrics.port (デフォルト: 9100)
// Prometheus 設定: config/prometheus.yml の orchestration-platform ジョブ
// ─────────────────────────────────────────────────────────────────────────────
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { metricsRegistry } from './metrics.ts';
import type { Logger } from './logger.ts';

/**
 * メトリクスサーバーを起動する。
 * @returns サーバーを停止する関数
 */
export function startMetricsServer(
  port:   number,
  host:   string,
  logger: Logger,
): () => void {
  const log = logger.child({ component: 'metrics-server' });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Prometheus の scrape エンドポイント
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        const body = await metricsRegistry.metrics();
        res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
        res.end(body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to collect metrics', { msg });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error collecting metrics: ${msg}`);
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, host, () => {
    log.info('Metrics server started', { port, host, endpoint: `http://${host}:${port}/metrics` });
  });

  return () => {
    server.close();
    log.info('Metrics server stopped');
  };
}
