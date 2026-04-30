// ─────────────────────────────────────────────────────────────────────────────
// クォータチェック アクティビティ
//
// Redis のスライディングウィンドウカウンターでリクエスト数を管理する。
// OPA (RBAC 認可) の後にワークフローから呼び出され、
// 「許可はされているが制限値に達した」リクエストを弾く。
//
// クォータ上限値の優先順位:
//   1. Redis に `quota_limit:{tenantId}:{resource}` が存在すれば使用
//      → 管理 API から動的に変更可能
//   2. なければ config.redis.defaultQuotaLimit を使用
// ─────────────────────────────────────────────────────────────────────────────
import type Redis from 'ioredis';
import { checkAndIncrementQuota, getTenantQuotaLimit } from '../cache.ts';
import { quotaChecksTotal }                            from '../metrics.ts';
import type { Config }                                 from '../config.ts';
import type { Logger }                                 from '../logger.ts';
import type { PlatformRequest, QuotaResult }           from '../types.ts';

export function createCheckQuotaActivity(config: Config, logger: Logger, redis: Redis) {
  const log = logger.child({ activity: 'checkQuotaActivity' });

  return async function checkQuotaActivity(request: PlatformRequest): Promise<QuotaResult> {
    const actLog = log.child({
      requestId: request.requestId,
      tenantId:  request.tenantId,
      userId:    request.userId,
      resource:  request.resource,
    });

    // ── クォータ上限値を決定 ────────────────────────────────────────────
    // テナント別 / リソース別の上限値を Redis から動的に取得する。
    // 未設定の場合はグローバルデフォルト値を使用する。
    const dynamicLimit = await getTenantQuotaLimit(
      redis,
      request.tenantId,
      request.resource,
    );
    const limit = dynamicLimit ?? config.redis.defaultQuotaLimit;

    // ── カウンターをインクリメントしてチェック ─────────────────────────
    const result = await checkAndIncrementQuota(
      redis,
      request.tenantId,
      request.userId,
      request.resource,
      limit,
      config.redis.quotaWindowSeconds,
    );

    // ── メトリクスを記録 ─────────────────────────────────────────────────
    quotaChecksTotal.inc({
      result:   result.allowed ? 'allowed' : 'exceeded',
      resource: request.resource,
    });

    if (result.allowed) {
      actLog.debug('Quota check passed', { current: result.current, limit: result.limit });
    } else {
      actLog.warn('Quota exceeded', { current: result.current, limit: result.limit });
    }

    return result;
  };
}
