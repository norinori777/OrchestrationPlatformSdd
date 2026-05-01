// ─────────────────────────────────────────────────────────────────────────────
// Prometheus メトリクス定義
//
// 収集対象:
//   - NATS JetStream: メッセージ受信数・ack/nak/DLQ カウント
//   - Temporal Workflow: 起動数・期間
//   - OPA: 許可/拒否の比率・判定レイテンシ
//   - Redis: クォータチェック結果・キャッシュヒット率
//   - Node.js デフォルト: CPU・メモリ・GC・イベントループ遅延
//
// 公開エンドポイント: GET /metrics (metricsServer.ts)
// Prometheus スクレイプ設定: config/prometheus.yml
// ─────────────────────────────────────────────────────────────────────────────
import { Counter, Histogram, collectDefaultMetrics, register } from 'prom-client';

// Node.js 標準メトリクス (CPU 使用率・ヒープメモリ・GC 時間・イベントループ遅延)
collectDefaultMetrics({ prefix: 'platform_nodejs_' });

// ── NATS JetStream メトリクス ────────────────────────────────────────────────

/** Gateway が受信したメッセージの総数 */
export const natsMessagesReceivedTotal = new Counter({
  name:       'platform_nats_messages_received_total',
  help:       'Total number of NATS JetStream messages received by the gateway',
  labelNames: ['subject'] as const,
});

/** 正常に ack したメッセージ数 */
export const natsMessagesAckedTotal = new Counter({
  name: 'platform_nats_messages_acked_total',
  help: 'Total number of NATS messages successfully acknowledged',
});

/** nak して再配送を要求したメッセージ数 */
export const natsMessagesNakTotal = new Counter({
  name: 'platform_nats_messages_nak_total',
  help: 'Total number of NATS messages nak\'d (pending retry by JetStream)',
});

/** Dead Letter Queue へ転送したメッセージ数 */
export const natsDlqTotal = new Counter({
  name: 'platform_nats_dlq_total',
  help: 'Total number of malformed messages forwarded to the Dead Letter Queue',
});

// ── Temporal / Workflow メトリクス ───────────────────────────────────────────

/** 起動したワークフロー数 */
export const workflowStartedTotal = new Counter({
  name:       'platform_workflow_started_total',
  help:       'Total number of Temporal workflows started',
  labelNames: ['task_queue'] as const,
});

// ── OPA ポリシー判定メトリクス ────────────────────────────────────────────────

/**
 * OPA ポリシー判定結果の総数
 * label: result = "allow" | "deny"
 * → allow / (allow + deny) で許可率を算出できる
 */
export const opaDecisionsTotal = new Counter({
  name:       'platform_opa_decisions_total',
  help:       'Total OPA policy decisions. Use result label to compute allow/deny ratio.',
  labelNames: ['result'] as const,  // "allow" | "deny"
});

/**
 * OPA 判定レイテンシ (秒)
 * ヒストグラムで分布を把握し、p95/p99 遅延を監視する
 */
export const opaDecisionDurationSeconds = new Histogram({
  name:    'platform_opa_decision_duration_seconds',
  help:    'OPA policy evaluation latency in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
});

// ── Redis クォータ / キャッシュ メトリクス ───────────────────────────────────

/**
 * クォータチェック結果の総数
 * label: result = "allowed" | "exceeded"
 * → exceeded が増加し始めたらリソースごとの制限値を見直す
 */
export const quotaChecksTotal = new Counter({
  name:       'platform_quota_checks_total',
  help:       'Total Redis quota checks. Use result label to track exceeded requests.',
  labelNames: ['result', 'resource'] as const,
});

/** Redis キャッシュヒット数 */
export const redisCacheHitsTotal = new Counter({
  name:       'platform_redis_cache_hits_total',
  help:       'Total Redis cache hits',
  labelNames: ['key_prefix'] as const,
});

/** Redis キャッシュミス数 */
export const redisCacheMissesTotal = new Counter({
  name:       'platform_redis_cache_misses_total',
  help:       'Total Redis cache misses',
  labelNames: ['key_prefix'] as const,
});

// ── 通知アクティビティ メトリクス ────────────────────────────────────────────

/** 正常に dispatch できた通知数 */
export const notificationsSentTotal = new Counter({
  name:       'platform_notifications_sent_total',
  help:       'Total notifications successfully dispatched (NATS publish + webhook)',
  labelNames: ['status'] as const,  // "allowed" | "denied" | "quota-exceeded" | "error"
});

/** dispatch に失敗した通知数 (ベストエフォートのため例外は飛ばさない) */
export const notificationsFailedTotal = new Counter({
  name:       'platform_notifications_failed_total',
  help:       'Total notification dispatch failures (non-fatal, best-effort)',
  labelNames: ['status'] as const,
});

// ── DLQ コンシューマー メトリクス ────────────────────────────────────────────

/** DLQ から取り出して処理したメッセージ数 */
export const dlqProcessedTotal = new Counter({
  name: 'platform_dlq_processed_total',
  help: 'Total DLQ messages processed by the DLQ consumer',
});

/** DLQ 警告 Webhook の送信結果 */
export const dlqAlertSentTotal = new Counter({
  name:       'platform_dlq_alert_sent_total',
  help:       'Total DLQ alert webhook calls',
  labelNames: ['result'] as const,  // "success" | "failure" | "error"
});

// デフォルトレジストリをエクスポート
// metricsServer.ts から register.metrics() を呼び出して /metrics を公開する
export { register as metricsRegistry };
