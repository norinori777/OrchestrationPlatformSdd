metrics.ts を読み、定義されているメトリクス名を確認します。次に Prometheus での検索クエリ（PromQL）を提案します。

Read [](file:///c%3A/work/OrchestrationPlatformSdd/src/product/metrics.ts)

まず作業を短く整理します：Prometheus検索例を作成し、主要メトリクスごとのPromQLを提示します。

To Do 項目が 2 件作成されました

短くまとめます — 主要メトリクス名に対する Prometheus（PromQL）検索例と Prometheus UI での使い方です。

- 基本：過去5分のレート（増分/秒）
  - Counters 全般（秒あたりレート）:
    rate(platform_nats_messages_received_total[5m])
  - 5分間の増分（合計増加量）:
    increase(platform_nats_messages_received_total[5m])

- NATS（subject ラベル別の受信数）
  - subject 別レート:
    sum by (subject) (rate(platform_nats_messages_received_total[5m]))

- Workflow 起動（task_queue ラベル別）
  - 起動レート:
    sum by (task_queue) (rate(platform_workflow_started_total[5m]))

- OPA 許可/拒否率
  - allow の割合（直近5分）:
    sum(rate(platform_opa_decisions_total{result="allow"}[5m])) / sum(rate(platform_opa_decisions_total[5m]))
  - allow と deny の時系列（カウント）:
    sum by (result) (rate(platform_opa_decisions_total[5m]))

- OPA レイテンシ（ヒストグラム → p95/p99）
  - p95:
    histogram_quantile(0.95, sum(rate(platform_opa_decision_duration_seconds_bucket[5m])) by (le))
  - p99:
    histogram_quantile(0.99, sum(rate(platform_opa_decision_duration_seconds_bucket[5m])) by (le))

- Redis キャッシュヒット率（key_prefix ラベルで集計）
  - ヒット率:
    sum(rate(platform_redis_cache_hits_total[5m])) by (key_prefix)
    /
    (sum(rate(platform_redis_cache_hits_total[5m])) by (key_prefix) + sum(rate(platform_redis_cache_misses_total[5m])) by (key_prefix))

- 通知（status ラベル別）
  - status 別送信レート:
    sum by (status) (rate(platform_notifications_sent_total[5m]))
  - 失敗率（例）:
    sum(rate(platform_notifications_failed_total[5m])) / sum(rate(platform_notifications_sent_total[5m]))

- DLQ 処理状況
  - DLQ 処理レート:
    rate(platform_dlq_processed_total[5m])

- Node.js デフォルトメトリクスを探す（プレフィックス）
  - 名前一覧表示（メトリクス探索用）:
    {__name__=~"platform_nodejs_.*"}

Prometheus UI での検索手順（簡潔）:
- Prometheus の Web UI を開く（例: http://localhost:9090/graph）。
- クエリ入力欄に上記 PromQL を貼り付ける。
- 「Execute」またはグラフボタンで即時値／時系列を確認（右上で時間範囲を選択）。
- ラベルで絞るには `{label="value"}` を使う（例: platform_nats_messages_received_total{subject="platform.events.orders"}）。
- 利用例：許可率のアラート化は上記の割合式を `for` と組み合わせた Alertmanager ルールに落とせます。

必要なら、特定のメトリクス名でダッシュボード（Grafana）向けの短いパネル定義例も作りますか？