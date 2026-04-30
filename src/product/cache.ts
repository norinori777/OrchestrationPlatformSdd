// ─────────────────────────────────────────────────────────────────────────────
// Redis クライアント & キャッシュユーティリティ
//
// 用途:
//   1. クォータチェック  — ユーザー/リソースごとのレート制限 (Lua 原子操作)
//   2. OPA 判断材料キャッシュ — テナントのクォータ上限値を Redis に保持
//   3. サービス間フラグ共有  — 一時的な feature flag / メンテナンスモード等
//
// 依存: ioredis
//   npm install ioredis
// ─────────────────────────────────────────────────────────────────────────────
import Redis from 'ioredis';
import { redisCacheHitsTotal, redisCacheMissesTotal } from './metrics.ts';

// ─────────────────────────────────────────────────────────────────────────────
// クライアントファクトリ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redis クライアントを生成して返す。
 * ioredis は lazyConnect=false のためコンストラクタ呼び出し時に接続を開始する。
 * 接続失敗時は retryStrategy で指数バックオフ。
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    retryStrategy: (times: number) => {
      if (times > 10) return null; // 10 回失敗したら断念
      return Math.min(times * 200, 3_000); // 最大 3 秒間隔
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck:     true,
    lazyConnect:          false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// クォータチェック
// ─────────────────────────────────────────────────────────────────────────────

export interface QuotaResult {
  /** クォータ内かどうか */
  allowed: boolean;
  /** 現在のウィンドウ内リクエスト数 */
  current: number;
  /** 設定されたクォータ上限 */
  limit: number;
}

/**
 * Redis を使ったスライディングウィンドウ クォータチェック。
 *
 * Lua スクリプトで INCR + EXPIRE を原子的に実行するため、
 * 並列リクエストが到着しても正確なカウントを保証する。
 *
 * Key: quota:{tenantId}:{userId}:{resource}
 * TTL: windowSeconds (例: 3600 = 1 時間)
 */
export async function checkAndIncrementQuota(
  redis:         Redis,
  tenantId:      string,
  userId:        string,
  resource:      string,
  limit:         number,
  windowSeconds: number,
): Promise<QuotaResult> {
  const key = `quota:${tenantId}:${userId}:${resource}`;

  // Lua で INCR + 初回のみ EXPIRE を原子的に実行
  const current = await redis.eval(
    `local n = redis.call('INCR', KEYS[1])
     if n == 1 then
       redis.call('EXPIRE', KEYS[1], ARGV[1])
     end
     return n`,
    1,         // KEYS の個数
    key,       // KEYS[1]
    String(windowSeconds), // ARGV[1]
  ) as number;

  return { allowed: current <= limit, current, limit };
}

/**
 * テナントのクォータ上限値を Redis から取得する。
 * 存在しない場合は null を返す (呼び出し側でデフォルト値を使う)。
 *
 * Key: quota_limit:{tenantId}:{resource}
 */
export async function getTenantQuotaLimit(
  redis:    Redis,
  tenantId: string,
  resource: string,
): Promise<number | null> {
  const key   = `quota_limit:${tenantId}:${resource}`;
  const value = await redis.get(key);

  if (value !== null) {
    redisCacheHitsTotal.inc({ key_prefix: 'quota_limit' });
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }

  redisCacheMissesTotal.inc({ key_prefix: 'quota_limit' });
  return null;
}

/**
 * テナントのクォータ上限値を Redis に設定する。
 * (管理 API や初期化スクリプトから呼び出す)
 */
export async function setTenantQuotaLimit(
  redis:        Redis,
  tenantId:     string,
  resource:     string,
  limit:        number,
  ttlSeconds:   number = 86_400, // デフォルト 24 時間
): Promise<void> {
  const key = `quota_limit:${tenantId}:${resource}`;
  await redis.set(key, String(limit), 'EX', ttlSeconds);
}

// ─────────────────────────────────────────────────────────────────────────────
// 汎用キャッシュ操作
// ─────────────────────────────────────────────────────────────────────────────

/** キーを指定して値を取得。ヒット/ミスをメトリクスに記録する */
export async function cacheGet(
  redis:     Redis,
  key:       string,
  keyPrefix: string,
): Promise<string | null> {
  const value = await redis.get(key);
  if (value !== null) {
    redisCacheHitsTotal.inc({ key_prefix: keyPrefix });
  } else {
    redisCacheMissesTotal.inc({ key_prefix: keyPrefix });
  }
  return value;
}

/** キーに値をセットする (オプションで TTL 付き) */
export async function cacheSet(
  redis:      Redis,
  key:        string,
  value:      string,
  ttlSeconds?: number,
): Promise<void> {
  if (ttlSeconds !== undefined) {
    await redis.set(key, value, 'EX', ttlSeconds);
  } else {
    await redis.set(key, value);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// サービス間フラグ共有
// ─────────────────────────────────────────────────────────────────────────────

/** フラグ名で一時的な共有フラグを読む (例: "maintenance", "feature-xyz") */
export async function getServiceFlag(
  redis:    Redis,
  flagName: string,
): Promise<string | null> {
  return cacheGet(redis, `flag:${flagName}`, 'service_flag');
}

/** フラグを設定する。ttlSeconds 未指定で永続 */
export async function setServiceFlag(
  redis:      Redis,
  flagName:   string,
  value:      string,
  ttlSeconds?: number,
): Promise<void> {
  return cacheSet(redis, `flag:${flagName}`, value, ttlSeconds);
}

/** フラグを削除する */
export async function deleteServiceFlag(
  redis:    Redis,
  flagName: string,
): Promise<void> {
  await redis.del(`flag:${flagName}`);
}
