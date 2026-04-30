// ─────────────────────────────────────────────────────────────────────────────
// Configuration — 環境変数からロード、デフォルト値付き
// 実運用では .env ファイルではなく、K8s Secret / AWS SSM / Vault などで
// 環境変数を注入してください。
// ─────────────────────────────────────────────────────────────────────────────

export interface TemporalConfig {
  address: string;
  namespace: string;
  taskQueue: string;
}

export interface NatsConfig {
  servers: string;
  streamName: string;
  subjects: string[];
  consumerName: string;
  dlqSubject: string;
  maxDeliver: number;
  ackWaitSeconds: number;
}

export interface OpaConfig {
  baseUrl: string;
  /** OPA REST API のデータパス (例: platform/authz/allow) */
  policyPath: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface HealthConfig {
  port: number;
  host: string;
}

export interface RedisConfig {
  url: string;
  /** クォータ集計ウィンドウ (秒)。デフォルト 3600 = 1 時間 */
  quotaWindowSeconds: number;
  /** テナント別設定がない場合のデフォルトクォータ上限 */
  defaultQuotaLimit: number;
}

export interface MetricsConfig {
  /** /metrics を公開するポート (Prometheus スクレイプ先) */
  port: number;
  host: string;
}

export interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
}

export interface Config {
  temporal: TemporalConfig;
  nats: NatsConfig;
  opa: OpaConfig;
  health: HealthConfig;
  redis: RedisConfig;
  metrics: MetricsConfig;
  log: LogConfig;
  /** SaaS Backend のベース URL。完了時に saas_requests のステータスを更新するコールバックに使用 */
  saasBackendUrl: string;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be a number, got: "${v}"`);
  return n;
}

export function loadConfig(): Config {
  return {
    temporal: {
      address:   env('TEMPORAL_ADDRESS',   'localhost:7233'),
      namespace: env('TEMPORAL_NAMESPACE', 'default'),
      taskQueue: env('TEMPORAL_TASK_QUEUE', 'platform-task-queue'),
    },
    nats: {
      servers:        env('NATS_SERVERS',        'localhost:4222'),
      streamName:     env('NATS_STREAM_NAME',    'PLATFORM'),
      subjects:       env('NATS_SUBJECTS',       'platform.events.>').split(','),
      consumerName:   env('NATS_CONSUMER_NAME',  'platform-worker'),
      dlqSubject:     env('NATS_DLQ_SUBJECT',    'platform.dlq'),
      maxDeliver:     envNum('NATS_MAX_DELIVER',    3),
      ackWaitSeconds: envNum('NATS_ACK_WAIT_SECS', 30),
    },
    opa: {
      baseUrl:    env('OPA_BASE_URL',    'http://localhost:8181'),
      policyPath: env('OPA_POLICY_PATH', 'platform/authz/allow'),
      timeoutMs:  envNum('OPA_TIMEOUT_MS',  5_000),
      maxRetries: envNum('OPA_MAX_RETRIES', 3),
    },
    health: {
      port: envNum('HEALTH_PORT', 3000),
      host: env('HEALTH_HOST',   '0.0.0.0'),
    },
    redis: {
      url:                env('REDIS_URL',               'redis://localhost:6379'),
      quotaWindowSeconds: envNum('REDIS_QUOTA_WINDOW_SECS', 3_600),
      defaultQuotaLimit:  envNum('REDIS_DEFAULT_QUOTA_LIMIT', 1_000),
    },
    metrics: {
      port: envNum('METRICS_PORT', 9100),
      host: env('METRICS_HOST',   '0.0.0.0'),
    },
    log: {
      level:   env('LOG_LEVEL',    'info') as LogConfig['level'],
      service: env('SERVICE_NAME', 'orchestration-platform'),
    },
    saasBackendUrl: env('SAAS_BACKEND_URL', 'http://localhost:3001'),
  };
}
