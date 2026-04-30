// ─────────────────────────────────────────────────────────────────────────────
// 永続化アクティビティ (PostgreSQL)
// 実運用では `pg` パッケージを追加し、コメントアウトされた SQL を有効化してください:
//   npm install pg @types/pg
// ─────────────────────────────────────────────────────────────────────────────
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { PlatformRequest, RequestStatus } from '../types.ts';

// pg を使う場合はここでプールを初期化する
// import pg from 'pg';
// const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export function createPersistRequestActivity(_config: Config, logger: Logger) {
  const log = logger.child({ activity: 'persistRequestActivity' });

  return async function persistRequestActivity(
    request: PlatformRequest,
    status: RequestStatus,
  ): Promise<void> {
    const actLog = log.child({ requestId: request.requestId, status });

    // ── 実装例 (PostgreSQL upsert) ────────────────────────────────────────
    // await pool.query(
    //   `INSERT INTO platform_requests
    //      (id, tenant_id, user_id, action, resource, status, created_at, updated_at)
    //    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    //    ON CONFLICT (id)
    //    DO UPDATE SET status = $6, updated_at = NOW()`,
    //   [
    //     request.requestId,
    //     request.tenantId,
    //     request.userId,
    //     request.action,
    //     request.resource,
    //     status,
    //   ],
    // );
    // ─────────────────────────────────────────────────────────────────────

    actLog.info('Request persisted');
  };
}
