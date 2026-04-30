// ─────────────────────────────────────────────────────────────────────────────
// 永続化アクティビティ (Prisma + PostgreSQL)
//
// 責務:
//   1. platform_requests へ upsert (platform スキーマ — 正源)
//   2. SaaS Backend の PATCH /api/requests/:requestId/status を呼び出して
//      saas_requests のステータスも同期する (ベストエフォート)
// ─────────────────────────────────────────────────────────────────────────────
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { PlatformRequest, RequestStatus } from '../types.ts';
// @ts-ignore — カスタム出力パスから生成された Prisma Client
import { PrismaClient, Prisma } from '../../../node_modules/.prisma/product-client/index.js';

const prisma = new PrismaClient();

export function createPersistRequestActivity(config: Config, logger: Logger) {
  const log = logger.child({ activity: 'persistRequestActivity' });

  return async function persistRequestActivity(
    request: PlatformRequest,
    status: RequestStatus,
    result?: string,
  ): Promise<void> {
    const actLog = log.child({ requestId: request.requestId, status });

    // ── 1. platform_requests へ upsert (正源) ───────────────────────────
    await prisma.platformRequest.upsert({
      where:  { id: request.requestId },
      create: {
        id:       request.requestId,
        tenantId: request.tenantId,
        userId:   request.userId,
        action:   request.action,
        resource: request.resource,
        status,
        payload:  (request.payload ?? {}) as Prisma.InputJsonValue,
        ...(result !== undefined ? { result } : {}),
      },
      update: {
        status,
        payload: (request.payload ?? {}) as Prisma.InputJsonValue,
        ...(result !== undefined ? { result } : {}),
      },
    });

    // ── 2. SaaS Backend へコールバック (ベストエフォート) ───────────────
    try {
      const url = `${config.saasBackendUrl}/api/requests/${encodeURIComponent(request.requestId)}/status`;
      const res = await fetch(url, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status, ...(result !== undefined ? { result } : {}) }),
        signal:  AbortSignal.timeout(5_000),
      });
      if (!res.ok && res.status !== 404) {
        // 404 は SaaS Backend に該当リクエストが存在しない場合 (直接テスト時など) — 無視
        actLog.warn('SaaS Backend status callback failed', { httpStatus: res.status });
      }
    } catch (callbackErr) {
      // コールバック失敗はワークフローを止めない (ベストエフォート)
      actLog.warn('SaaS Backend status callback error (ignored)', { err: String(callbackErr) });
    }

    actLog.info('Request persisted');
  };
}
