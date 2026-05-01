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
  /** DLQ メッセージを永続化する JetStream ストリーム名 */
  dlqStreamName: string;
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

export interface NotificationConfig {
  /**
   * NATS パブリッシュ先のサブジェクトプレフィックス
   * 実際のサブジェクトは `{natsSubject}.{tenantId}` になる
   * (例: platform.notifications → platform.notifications.tenant-a)
   */
  natsSubject: string;
  /** 外部 Webhook URL (Slack / Teams / カスタム)。空文字列 = 無効 */
  webhookUrl: string;
  /** Webhook リクエストタイムアウト (ms) */
  webhookTimeoutMs: number;
}

export interface OtelConfig {
  /** OpenTelemetry の有効・無効 */
  enabled: boolean;
  /** OTLP/HTTP トレースエクスポーター URL (Jaeger / Grafana Tempo) */
  otlpEndpoint: string;
  /** service.name 属性 */
  serviceName: string;
  /** service.version 属性 */
  serviceVersion: string;
  /** deployment.environment 属性 */
  environment: string;
}

export interface Config {
  temporal: TemporalConfig;
  nats: NatsConfig;
  opa: OpaConfig;
  health: HealthConfig;
  redis: RedisConfig;
  metrics: MetricsConfig;
  log: LogConfig;
  otel: OtelConfig;
  notification: NotificationConfig;
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

// ─────────────────────────────────────────────────────────────────────────────
// 起動時バリデーション — 不正な設定をフェイルファストで検出
// ─────────────────────────────────────────────────────────────────────────────
function validatePort(name: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Config error: ${name} must be an integer between 1 and 65535 (got ${port})`);
  }
}

function validateUrl(name: string, value: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`Config error: ${name} must be a valid URL (got "${value}")`);
  }
}

function validateNonEmpty(name: string, value: string): void {
  if (value.trim() === '') {
    throw new Error(`Config error: ${name} must not be empty`);
  }
}

function validateConfig(cfg: Config): void {
  // Temporal
  validateNonEmpty('temporal.address', cfg.temporal.address);
  validateNonEmpty('temporal.namespace', cfg.temporal.namespace);
  validateNonEmpty('temporal.taskQueue', cfg.temporal.taskQueue);

  // NATS
  validateNonEmpty('nats.servers', cfg.nats.servers);
  validateNonEmpty('nats.streamName', cfg.nats.streamName);
  validateNonEmpty('nats.dlqStreamName', cfg.nats.dlqStreamName);
  if (cfg.nats.maxDeliver < 1) {
    throw new Error(`Config error: nats.maxDeliver must be >= 1 (got ${cfg.nats.maxDeliver})`);
  }

  // OPA
  validateUrl('opa.baseUrl', cfg.opa.baseUrl);
  validateNonEmpty('opa.policyPath', cfg.opa.policyPath);
  if (cfg.opa.timeoutMs < 1) {
    throw new Error(`Config error: opa.timeoutMs must be >= 1 (got ${cfg.opa.timeoutMs})`);
  }
  if (cfg.opa.maxRetries < 1) {
    throw new Error(`Config error: opa.maxRetries must be >= 1 (got ${cfg.opa.maxRetries})`);
  }

  // Redis
  validateUrl('redis.url', cfg.redis.url);
  if (cfg.redis.quotaWindowSeconds < 1) {
    throw new Error(`Config error: redis.quotaWindowSeconds must be >= 1 (got ${cfg.redis.quotaWindowSeconds})`);
  }
  if (cfg.redis.defaultQuotaLimit < 1) {
    throw new Error(`Config error: redis.defaultQuotaLimit must be >= 1 (got ${cfg.redis.defaultQuotaLimit})`);
  }

  // Ports
  validatePort('health.port',  cfg.health.port);
  validatePort('metrics.port', cfg.metrics.port);

  // SaaS Backend
  validateUrl('saasBackendUrl', cfg.saasBackendUrl);

  // Notification webhook URL は空文字列を許容 (無効化を意味する) — 値があれば検証
  if (cfg.notification.webhookUrl !== '') {
    validateUrl('notification.webhookUrl', cfg.notification.webhookUrl);
  }
  if (cfg.notification.webhookTimeoutMs < 1) {
    throw new Error(`Config error: notification.webhookTimeoutMs must be >= 1 (got ${cfg.notification.webhookTimeoutMs})`);
  }
}

export function loadConfig(): Config {
  const cfg: Config = {
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
      dlqStreamName:  env('NATS_DLQ_STREAM_NAME', 'PLATFORM-DLQ'),
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
    otel: {
      enabled:        env('OTEL_ENABLED', 'true') === 'true',
      otlpEndpoint:   env('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318/v1/traces'),
      serviceName:    env('SERVICE_NAME',    'orchestration-platform'),
      serviceVersion: env('SERVICE_VERSION', '1.0.0'),
      environment:    env('DEPLOY_ENV',      'development'),
    },
    notification: {
      natsSubject:      env('NOTIFICATION_NATS_SUBJECT',          'platform.notifications'),
      webhookUrl:       env('NOTIFICATION_WEBHOOK_URL',           ''),
      webhookTimeoutMs: envNum('NOTIFICATION_WEBHOOK_TIMEOUT_MS', 5_000),
    },
    saasBackendUrl: env('SAAS_BACKEND_URL', 'http://localhost:3001'),
  };
  validateConfig(cfg);
  return cfg;
}
