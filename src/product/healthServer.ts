// ─────────────────────────────────────────────────────────────────────────────
// ヘルスチェック HTTP サーバー
//
// エンドポイント:
//   GET /health/live  — Liveness: プロセスが生きているか
//   GET /health/ready — Readiness: 依存サービスが利用可能か (503 if degraded)
//
// K8s / ECS のヘルスチェックプローブと連携します。
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'http';
import type { Logger } from './logger.ts';

export type HealthCheck = () => Promise<boolean>;

interface HealthServerOptions {
  port:   number;
  host:   string;
  /** 名前付きヘルスチェック関数のマップ */
  checks: Record<string, HealthCheck>;
}

/**
 * ヘルスサーバーを起動して、停止用関数を返す。
 */
export function startHealthServer(
  options: HealthServerOptions,
  logger: Logger,
): () => void {
  const log = logger.child({ component: 'health' });

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';

    // Liveness — プロセスが起動していれば常に 200
    if (url === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Readiness — 全チェックが true なら 200、いずれか失敗で 503
    if (url === '/health/ready') {
      const results: Record<string, boolean> = {};
      let allOk = true;

      await Promise.all(
        Object.entries(options.checks).map(async ([name, check]) => {
          try {
            results[name] = await check();
          } catch {
            results[name] = false;
          }
          if (!results[name]) allOk = false;
        }),
      );

      res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: allOk ? 'ok' : 'degraded', checks: results }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(options.port, options.host, () => {
    log.info('Health server started', { host: options.host, port: options.port });
  });

  return () => server.close();
}
