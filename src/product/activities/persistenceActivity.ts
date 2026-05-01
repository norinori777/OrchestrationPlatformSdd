// ─────────────────────────────────────────────────────────────────────────────
// 永続化アクティビティ (Prisma + PostgreSQL)
//
// 責務:
//   1. platform_requests へ upsert (platform スキーマ — 正源)
//   2. SaaS Backend の PATCH /api/requests/:requestId/status を呼び出して
//      saas_requests のステータスも同期する (ベストエフォート)
// ・OpenTelemetry スパン計装: db.persist_request / http.saas_callback
// ─────────────────────────────────────────────────────────────────────────────
import { SpanStatusCode }  from '@opentelemetry/api';
import { getTracer }       from '../telemetry.ts';
import type { Config }     from '../config.ts';
import type { Logger }     from '../logger.ts';
import type { PlatformRequest, RequestStatus } from '../types.ts';
// @ts-ignore — カスタム出力パスから生成された Prisma Client
import { PrismaClient, Prisma } from '../../../node_modules/.prisma/product-client/index.js';

/** Prisma P2002 ユニーク制約違反—リトライ不要エラー */
export class DuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`Duplicate request ID: ${requestId}`);
    this.name = 'DuplicateRequestError';
  }
}

export function createPersistRequestActivity(
  config: Config,
  logger: Logger,
  prisma: InstanceType<typeof PrismaClient>,
) {
  const log    = logger.child({ activity: 'persistRequestActivity' });
  const tracer = getTracer('platform.persistence');

  return async function persistRequestActivity(
    request: PlatformRequest,
    status: RequestStatus,
    result?: string,
  ): Promise<void> {
    const actLog = log.child({ requestId: request.requestId, status });

    await tracer.startActiveSpan('db.persist_request', async (span) => {
      span.setAttributes({
        'db.system':           'postgresql',
        'db.operation':        'upsert',
        'db.sql.table':        'platform_requests',
        'platform.request_id': request.requestId,
        'platform.tenant_id':  request.tenantId,
        'platform.status':     status,
      });

      try {
        // ── 1. platform_requests へ upsert (正源) ─────────────────────────
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

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err: unknown) {
        // P2002 = Unique constraint violation — リトライ不要
        if (
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'P2002'
        ) {
          span.end();
          throw new DuplicateRequestError(request.requestId);
        }
        span.recordException(err as Error);
        span.setStatus({
          code:    SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }

      span.end();
    });

    // ── 2. SaaS Backend へコールバック (ベストエフォート) ─────────────
    await tracer.startActiveSpan('http.saas_callback', async (cbSpan) => {
      const url = `${config.saasBackendUrl}/api/requests/${encodeURIComponent(request.requestId)}/status`;
      cbSpan.setAttributes({
        'http.method': 'PATCH',
        'http.url':    url,
        'platform.request_id': request.requestId,
        'platform.status':     status,
      });

      try {
        const res = await fetch(url, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ status, ...(result !== undefined ? { result } : {}) }),
          signal:  AbortSignal.timeout(5_000),
        });

        cbSpan.setAttribute('http.response.status_code', res.status);

        if (!res.ok && res.status !== 404) {
          actLog.warn('SaaS Backend status callback failed', { httpStatus: res.status });
          cbSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
        } else {
          cbSpan.setStatus({ code: SpanStatusCode.OK });
        }
      } catch (callbackErr) {
        // コールバック失敗はワークフローを止めない (ベストエフォート)
        actLog.warn('SaaS Backend status callback error (ignored)', { err: String(callbackErr) });
        cbSpan.recordException(callbackErr as Error);
        cbSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(callbackErr) });
      }

      cbSpan.end();
    });

    actLog.info('Request persisted');
  };
}
