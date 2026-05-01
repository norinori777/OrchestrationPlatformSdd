// ─────────────────────────────────────────────────────────────────────────────
// アクティビティレジストリ
// ワーカーへ渡す activities オブジェクトと、ワークフローが型推論で使う
// PlatformActivities 型をここで一元管理します。
// ─────────────────────────────────────────────────────────────────────────────
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { PlatformRequest, PolicyInput, NotificationPayload, RequestStatus, QuotaResult } from '../types.ts';
import type Redis from 'ioredis';
import type { NatsConnection } from 'nats';
import { SpanStatusCode }                        from '@opentelemetry/api';
import { getTracer }                             from '../telemetry.ts';
import { createEvaluatePolicyActivity }   from './opaActivity.ts';
import { createSendNotificationActivity } from './notificationActivity.ts';
import { createPersistRequestActivity }   from './persistenceActivity.ts';
import { createCheckQuotaActivity }       from './quotaActivity.ts';
// @ts-ignore — カスタム出力パスから生成された Prisma Client
import { PrismaClient } from '../../../node_modules/.prisma/product-client/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// マイクロサービス接続先 (環境変数で上書き可)
// ─────────────────────────────────────────────────────────────────────────────
const FILE_STORAGE_URL = process.env.FILE_STORAGE_SERVICE_URL ?? 'http://localhost:4001';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL         ?? 'http://localhost:4002';

type RequestHandler = (request: PlatformRequest) => Promise<string>;

type CompensationHandler = (request: PlatformRequest) => Promise<string>;

// ─────────────────────────────────────────────────────────────────────────────
// ハンドラマップ — action:resource → マイクロサービス HTTP 委譲
// ─────────────────────────────────────────────────────────────────────────────
const handlers: Record<string, RequestHandler> = {

  // ── File Storage Service (:4001) ──────────────────────────────────────────
  'create:files': async (req) => {
    const { filename, size, contentType, storagePath } =
      req.payload as { filename: string; size?: number; contentType?: string; storagePath: string };
    const res = await fetch(`${FILE_STORAGE_URL}/api/files`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: req.requestId, tenantId: req.tenantId, userId: req.userId, filename, size, contentType, storagePath }),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FileStorageService POST: HTTP ${res.status}`);
    const data = await res.json() as { id: string; filename: string };
    return `File created: id=${data.id}, filename=${data.filename}`;
  },

  'read:files': async (req) => {
    const { fileId } = req.payload as { fileId: string };
    const res = await fetch(`${FILE_STORAGE_URL}/api/files/${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FileStorageService GET: HTTP ${res.status}`);
    const data = await res.json() as { id: string; filename: string; storagePath: string };
    return `File retrieved: id=${data.id}, filename=${data.filename}`;
  },

  'delete:files': async (req) => {
    const { fileId } = req.payload as { fileId: string };
    const res = await fetch(`${FILE_STORAGE_URL}/api/files/${encodeURIComponent(fileId)}`, {
      method:  'DELETE',
      headers: { 'X-Tenant-Id': req.tenantId },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FileStorageService DELETE: HTTP ${res.status}`);
    return `File deleted: id=${fileId}`;
  },

  // ── User Service (:4002) ──────────────────────────────────────────────────
  'create:users': async (req) => {
    const { email, name, role } = req.payload as { email: string; name: string; role?: string };
    const res = await fetch(`${USER_SERVICE_URL}/api/users`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: req.requestId, tenantId: req.tenantId, email, name, role: role ?? 'viewer' }),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`UserService POST: HTTP ${res.status}`);
    const data = await res.json() as { id: string; email: string };
    return `User created: id=${data.id}, email=${data.email}`;
  },

  'read:users': async (req) => {
    const { userId } = req.payload as { userId: string };
    const res = await fetch(`${USER_SERVICE_URL}/api/users/${encodeURIComponent(userId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`UserService GET: HTTP ${res.status}`);
    const data = await res.json() as { id: string; email: string; name: string };
    return `User retrieved: id=${data.id}, email=${data.email}`;
  },

  'delete:users': async (req) => {
    const { userId } = req.payload as { userId: string };
    const res = await fetch(`${USER_SERVICE_URL}/api/users/${encodeURIComponent(userId)}`, {
      method:  'DELETE',
      headers: { 'X-Tenant-Id': req.tenantId },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`UserService DELETE: HTTP ${res.status}`);
    return `User deleted: id=${userId}`;
  },
};

const compensationHandlers: Record<string, CompensationHandler> = {
  'create:files': async (req) => {
    const res = await fetch(`${FILE_STORAGE_URL}/api/files/${encodeURIComponent(req.requestId)}`, {
      method:  'DELETE',
      headers: { 'X-Tenant-Id': req.tenantId },
      signal:  AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return `File compensation skipped: id=${req.requestId} was already absent`;
    if (!res.ok) throw new Error(`FileStorageService compensation DELETE: HTTP ${res.status}`);
    return `File compensation completed: id=${req.requestId}`;
  },

  'create:users': async (req) => {
    const res = await fetch(`${USER_SERVICE_URL}/api/users/${encodeURIComponent(req.requestId)}`, {
      method:  'DELETE',
      headers: { 'X-Tenant-Id': req.tenantId },
      signal:  AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return `User compensation skipped: id=${req.requestId} was already absent`;
    if (!res.ok) throw new Error(`UserService compensation DELETE: HTTP ${res.status}`);
    return `User compensation completed: id=${req.requestId}`;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ドメインロジック アクティビティ
// ─────────────────────────────────────────────────────────────────────────────
async function processRequestActivity(request: PlatformRequest): Promise<string> {
  const key     = `${request.action}:${request.resource}`;
  const handler = handlers[key];
  if (!handler) throw new Error(`No handler registered for "${key}"`);

  const tracer = getTracer('platform.process');
  return tracer.startActiveSpan(`process.${key}`, async (span) => {
    span.setAttributes({
      'platform.request_id': request.requestId,
      'platform.tenant_id':  request.tenantId,
      'platform.action':     request.action,
      'platform.resource':   request.resource,
      'http.request.method': request.action === 'read' ? 'GET'
                           : request.action === 'delete' ? 'DELETE' : 'POST',
    });
    try {
      const result = await handler(request);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err: unknown) {
      span.recordException(err as Error);
      span.setStatus({
        code:    SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.end();
      throw err;
    }
  });
}

async function compensateRequestActivity(request: PlatformRequest): Promise<string> {
  const key     = `${request.action}:${request.resource}`;
  const handler = compensationHandlers[key];
  if (!handler) {
    return `No compensation registered for "${key}"`;
  }

  const tracer = getTracer('platform.compensate');
  return tracer.startActiveSpan(`compensate.${key}`, async (span) => {
    span.setAttributes({
      'platform.request_id': request.requestId,
      'platform.tenant_id':  request.tenantId,
      'platform.action':     request.action,
      'platform.resource':   request.resource,
      'http.request.method': 'DELETE',
    });
    try {
      const result = await handler(request);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err: unknown) {
      span.recordException(err as Error);
      span.setStatus({
        code:    SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.end();
      throw err;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ファクトリ — config/logger を DI してワーカーへ渡すオブジェクトを生成
// ─────────────────────────────────────────────────────────────────────────────
export function createActivities(config: Config, logger: Logger, redis: Redis, nc: NatsConnection) {
  const prisma = new PrismaClient();
  return {
    evaluatePolicyActivity:   createEvaluatePolicyActivity(config, logger),
    sendNotificationActivity: createSendNotificationActivity(config, logger, nc),
    persistRequestActivity:   createPersistRequestActivity(config, logger, prisma),
    checkQuotaActivity:       createCheckQuotaActivity(config, logger, redis),
    compensateRequestActivity,
    processRequestActivity,
  };
}

/** ワークフロー側で proxyActivities に渡す型 */
export type PlatformActivities = {
  evaluatePolicyActivity(input: PolicyInput): Promise<boolean>;
  processRequestActivity(request: PlatformRequest): Promise<string>;
  compensateRequestActivity(request: PlatformRequest): Promise<string>;
  sendNotificationActivity(payload: NotificationPayload): Promise<void>;
  persistRequestActivity(request: PlatformRequest, status: RequestStatus, result?: string): Promise<void>;
  checkQuotaActivity(request: PlatformRequest): Promise<QuotaResult>;
};
