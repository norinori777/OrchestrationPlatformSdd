# オーケストレーションプラットフォーム 設計書

> 対象ディレクトリ: `src/product/`  
> バージョン: 1.4  
> 作成日: 2026-04-30  
> 改訂日: 2026-04-30 (v1.1 — Prometheus / Vector / Redis 追加)  
> 改訂日: 2026-04-30 (v1.2 — OPA diagnostic-addr / Vector VRL 修正)  
> 改訂日: 2026-05-01 (v1.3 — 通知アクティビティ本実装 + DLQ コンシューマー追加)  
> 改訂日: 2026-05-01 (v1.4 — ヘルスチェック充実 / PK重複非リトライ / 設定バリデーション / 補償ポリシー分離 / node-fetch 除去 / PrismaClient DI)

---

## 1. 目的・スコープ

本プラットフォームは、複数の SaaS テナントが共有する**イベント駆動型のオーケストレーション基盤**です。  
以下の責務を一元的に担います。

- NATS JetStream によるイベントの**耐久受信・再配送**
- Open Policy Agent (OPA) による**テナント RBAC 認可**
- Temporal による**ワークフローのステート管理と信頼性保証**
- PostgreSQL による**リクエスト永続化**
- **Redis** によるレート制限 (クォータ管理) と共有状態管理
- **Prometheus + prom-client** による定量的なメトリクス収集
- **Vector** によるコンテナログの集約・変換パイプライン
- Kubernetes / ECS に対応した**ヘルスチェックエンドポイント**

---

## 2. アーキテクチャ概要

### 2.1 コンポーネント構成

```
┌──────────────────────────────────────────────────────────────────────┐
│  イベント発行者 (他 SaaS / 外部システム)                              │
│  NATS subject: platform.events.{resource}                            │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ JetStream Publish
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  NATS JetStream                                                      │
│  Stream: PLATFORM   Consumer: platform-worker                        │
│  Retention: Workqueue   max_deliver: 3   ack_wait: 30s              │
│  DLQ subject: platform.dlq                                           │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ consume (explicit ack)
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Gateway (gateway.ts)                                                │
│  ・メッセージをデシリアライズ・バリデーション                          │
│  ・Temporal ワークフローを起動                                         │
│  ・成功 → ack / 失敗 → nak(5s) / 不正形式 → DLQ + ack               │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ client.start(platformWorkflow)
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Temporal Server (localhost:7233)                                    │
│  Namespace: default   TaskQueue: platform-task-queue                 │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ タスクディスパッチ
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Temporal Worker (worker.ts)                                         │
│  ├── Workflow: platformWorkflow                                       │
│  └── Activities:                                                     │
│       ├── evaluatePolicyActivity  (OPA HTTP API)                     │
│       ├── checkQuotaActivity      (Redis スライディングウィンドウ)      │
│       ├── processRequestActivity  (ドメインロジック)                   │
│       ├── sendNotificationActivity (Webhook/Email)                   │
│       └── persistRequestActivity  (PostgreSQL)                       │
└──────────────────────────────────────────────────────────────────────┘
                            │
           ┌────────────────┼──────────────────┐
           ▼                ▼                  ▼
    ┌─────────────────┐  ┌───────────┐    ┌──────────────┐
    │ OPA              │  │ PostgreSQL│    │ 通知先        │
    │ :8181 (REST API) │  │ :5432     │    │ (Webhook 等)  │
    │ :8282 (metrics)  │  └───────────┘    └──────────────┘
    └─────────────────┘

    ┌─────────────┐
    │ Redis       │  ← クォータカウンター / サービスフラグ
    │ :6379       │
    └─────────────┘

      Health Server     :3000   GET /health/live, /health/ready
      Metrics Server    :9100   GET /metrics  (Prometheus スクレイプ先)

┌──────────────────────────────────────────────────────────────────────┐
│  可観測性スタック                                                     │
│  Prometheus  :9090   メトリクス収集 (platform / OPA / NATS / Vector) │
│  Vector      :8686   コンテナログ集約 → parse → sink                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 ファイル構成

```
src/product/
├── config.ts                   設定ロード (環境変数ベース)
├── logger.ts                   構造化 JSON ロガー
├── types.ts                    共有型定義
├── metrics.ts                  Prometheus メトリクス定義
├── cache.ts                    Redis クライアント + クォータ / キャッシュヘルパー
├── worker.ts                   Temporal ワーカー起動
├── gateway.ts                  NATS → Temporal ゲートウェイ
├── healthServer.ts             HTTP ヘルスチェックサーバー (:3000)
├── metricsServer.ts            HTTP メトリクスサーバー (:9100)
├── index.ts                    メインエントリポイント
├── workflows/
│   └── platformWorkflow.ts    メインワークフロー定義
├── activities/
│   ├── index.ts               アクティビティレジストリ
│   ├── opaActivity.ts         OPA ポリシー評価 (Prometheus 計装済)
│   ├── quotaActivity.ts       Redis クォータチェック
│   ├── notificationActivity.ts 通知送信
│   └── persistenceActivity.ts DB 永続化
└── policies/
    ├── platform.rego           Rego ポリシー
    ├── platform-data.json      RBAC データ
    └── loadPolicy.ts           OPA ロードスクリプト
```

---

## 3. データフロー詳細

### 3.1 正常系フロー

```
イベント発行
  │
  ▼  NATS JetStream (durable consumer)
Gateway がメッセージ受信
  │  JSON デシリアライズ + バリデーション
  │  workflowId = "platform-{requestId}"  ← 冪等性キー
  ▼  client.start(platformWorkflow)
Temporal がワークフロー開始
  │
  ├─ Step 1: persistRequestActivity(request, "pending")
  │           → DB にリクエストを INSERT / UPSERT
  │
  ├─ Step 2: evaluatePolicyActivity(policyInput)
  │           → OPA POST /v1/data/platform/authz/allow
  │           → allow=true / false を返す
  │
  ├─ [allow=false]
  │   ├─ sendNotificationActivity("denied")
  │   ├─ persistRequestActivity(request, "denied")
  │   └─ ワークフロー終了 (status: denied)
  │
  └─ [allow=true]
      ├─ Step 3: checkQuotaActivity(request)
      │           → Redis INCR + Lua EXPIRE (原子操作)
      │           → allowed=true / false を返す
      │
      ├─ [allowed=false]
      │   ├─ sendNotificationActivity("denied")  ← quota-exceeded
      │   ├─ persistRequestActivity(request, "denied")
      │   └─ ワークフロー終了 (status: quota-exceeded)
      │
      └─ [allowed=true]
          ├─ Step 4: processRequestActivity(request)
          │           → ドメインロジック実行
          ├─ Step 5: sendNotificationActivity("allowed")
          ├─ Step 6: persistRequestActivity(request, "completed")
          └─ ワークフロー終了 (status: allowed)
```

### 3.2 異常系フロー

| 異常パターン | 挙動 |
|---|---|
| OPA 一時障害 | `opaActivity` が最大 3 回リトライ (指数バックオフ: 1s, 2s, 3s) |
| Temporal 起動失敗 | Gateway が `nak(5s)` → JetStream が再配送 (max 3 回) |
| 重複リクエスト | `workflowId` 衝突検出 → 冪等 `ack` (再処理なし) |
| 不正形式メッセージ | DLQ subject へ転送 → `ack` (リトライしない) |
| Activity 失敗 | Temporal が `maximumAttempts: 3` まで自動リトライ |
| キャンセルシグナル | `cancel` Signal 受信 → `persistRequestActivity("failed")` → 終了 |
| Redis 接続失敗 | `checkQuotaActivity` が Temporal によりリトライ (max 3 回) |
| クォータ超過 | `checkQuotaActivity` が `allowed=false` → quota-exceeded パスへ遷移 |
| **PK 重複 (P2002)** | `DuplicateRequestError` をスロー → Temporal が**リトライしない** (非リトライエラー) |
| **補償処理失敗** | 補償アクティビティ専用ポリシー (最大 5 回、60 秒タイムアウト) で独立リトライ |

---

## 4. モジュール設計

### 4.1 config.ts — 設定管理

環境変数から設定を読み込み、型付き `Config` オブジェクトを返します。  
数値変換に失敗した場合は起動時に即座にエラーをスローします（フェイルファスト）。  
**v1.4 から `validateConfig()` を追加。** `loadConfig()` 末尾で呼び出し、以下の条件を検査します。検査に失敗すると起動前に `Error` をスローします。

| 検査対象 | 条件 |
|---|---|
| URL 形式フィールド | `new URL()` でパース可能なこと (opa.baseUrl / redis.url / saasBackendUrl / notification.webhookUrl) |
| ポート番号 | 1〜65535 の整数 (health.port / metrics.port) |
| 必須文字列 | 空文字列でないこと (temporal.address/namespace/taskQueue / nats.servers/streamName/dlqStreamName) |
| 正の整数 | ≥1 であること (nats.maxDeliver / opa.timeoutMs / opa.maxRetries / redis.quotaWindowSeconds / redis.defaultQuotaLimit / notification.webhookTimeoutMs) |

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal gRPC エンドポイント |
| `TEMPORAL_NAMESPACE` | `default` | Temporal ネームスペース |
| `TEMPORAL_TASK_QUEUE` | `platform-task-queue` | タスクキュー名 |
| `NATS_SERVERS` | `localhost:4222` | NATS 接続先 |
| `NATS_STREAM_NAME` | `PLATFORM` | JetStream ストリーム名 |
| `NATS_SUBJECTS` | `platform.events.>` | サブスクライブ subject (カンマ区切り) |
| `NATS_CONSUMER_NAME` | `platform-worker` | 耐久コンシューマー名 |
| `NATS_DLQ_SUBJECT` | `platform.dlq` | Dead Letter Queue subject |
| `NATS_DLQ_STREAM_NAME` | `PLATFORM-DLQ` | DLQ JetStream ストリーム名 |
| `NATS_MAX_DELIVER` | `3` | 最大再配送回数 |
| `NATS_ACK_WAIT_SECS` | `30` | Ack タイムアウト (秒) |
| `OPA_BASE_URL` | `http://localhost:8181` | OPA REST API ベース URL |
| `OPA_POLICY_PATH` | `platform/authz/allow` | ポリシーデータパス |
| `OPA_TIMEOUT_MS` | `5000` | OPA リクエストタイムアウト (ms) |
| `OPA_MAX_RETRIES` | `3` | OPA リトライ最大回数 |
| `HEALTH_PORT` | `3000` | ヘルスチェックサーバーポート |
| `HEALTH_HOST` | `0.0.0.0` | ヘルスチェックサーバーバインドアドレス |
| `REDIS_URL` | `redis://localhost:6379` | Redis 接続 URL |
| `REDIS_QUOTA_WINDOW_SECS` | `3600` | クォータ集計ウィンドウ (秒) |
| `REDIS_DEFAULT_QUOTA_LIMIT` | `1000` | テナント別設定がない場合のデフォルトクォータ上限 |
| `METRICS_PORT` | `9100` | `/metrics` エンドポイントポート (Prometheus スクレイプ先) |
| `METRICS_HOST` | `0.0.0.0` | メトリクスサーバーバインドアドレス |
| `LOG_LEVEL` | `info` | ログレベル (debug/info/warn/error) |
| `SERVICE_NAME` | `orchestration-platform` | ログの `service` フィールド |

### 4.2 logger.ts — 構造化ロガー

JSON 形式で stdout (info/debug/warn) / stderr (error) へ出力します。  
`child(bindings)` で相関 ID やコンポーネント名を自動付与できます。

```json
{
  "ts": "2026-04-30T09:00:00.000Z",
  "level": "info",
  "service": "orchestration-platform",
  "component": "gateway",
  "requestId": "req-001",
  "msg": "Workflow started",
  "workflowId": "platform-req-001"
}
```

### 4.3 types.ts — 共有型定義

| 型 | 説明 |
|---|---|
| `PlatformRequest` | NATS から受信するリクエスト本体 |
| `PlatformResponse` | ワークフローの最終応答 (`status`: `allowed` / `denied` / `quota-exceeded` / `error`) |
| `PolicyInput` | OPA への認可クエリ入力 |
| `NotificationPayload` | 通知アクティビティへの入力 |
| `RequestStatus` | DB に記録するリクエストステータス (`pending` / `denied` / `completed` / `failed`) |
| `QuotaResult` | クォータチェック結果 (`allowed`, `current`, `limit`) |

### 4.4 workflows/platformWorkflow.ts — メインワークフロー

**Temporal の Deterministic Sandbox** で実行されるため、非決定的な IO は禁止です。  
すべての副作用はアクティビティ経由で行います。

| Signal | 型 | 動作 |
|---|---|---|
| `cancel` | `defineSignal` | ワークフローをキャンセルフラグで中断し、`failed` で永続化 |

| Query | 戻り値 | 動作 |
|---|---|---|
| `getStatus` | `string` | 現在の処理ステータス文字列を返す |

ステータス遷移:

```
started → persisting → evaluating-policy
  ├─ denied          → denied
  └─ allowed         → checking-quota
        ├─ quota-exceeded → denied
        └─ allowed       → processing → notifying → completed
```

#### アクティビティリトライポリシー (v1.4 更新)

**通常アクティビティ** (`proxyActivities` ブロック 1):

| 設定項目 | 値 |
|---|---|
| `startToCloseTimeout` | 30 秒 |
| `maximumAttempts` | 3 |
| `initialInterval` | 1 秒 |
| `backoffCoefficient` | 2 |
| `maximumInterval` | 30 秒 |
| `nonRetryableErrorTypes` | `['PolicyViolation', 'DuplicateRequestError']` |

**補償アクティビティ** (`compensateRequestActivity` — `proxyActivities` ブロック 2):

| 設定項目 | 値 | 理由 |
|---|---|---|
| `startToCloseTimeout` | **60 秒** | 補償処理は外部 API 呼び出しが含まれるため長めに設定 |
| `maximumAttempts` | **5** | 補償はビジネス的に重要なため通常より多くリトライ |
| `initialInterval` | 2 秒 | |
| `backoffCoefficient` | 2 | |
| `maximumInterval` | 60 秒 | |
| `nonRetryableErrorTypes` | `[]` | 補償はあらゆるエラーでリトライする |

### 4.5 activities/ — アクティビティ群

#### evaluatePolicyActivity (opaActivity.ts)

- OPA REST API `POST /v1/data/{policyPath}` を呼び出す
- **Node.js 18+ グローバル `fetch` を使用** (v1.4 で `node-fetch` 依存を除去)
- `AbortController` によるタイムアウト制御
- 独自指数バックオフリトライ (1s, 2s, 3s…)
- Temporal のリトライとの二重化を避けるため、アクティビティ内でリトライを完結させる設計
- **Prometheus 計装**: `platform_opa_decisions_total{result}` カウンター + `platform_opa_decision_duration_seconds` ヒストグラム

#### checkQuotaActivity (quotaActivity.ts) — NEW

- Redis の Lua スクリプトで `INCR + EXPIRE` を**原子的**に実行し、スライディングウィンドウカウンターを実装
- クォータ上限値の優先順位:
  1. Redis の `quota_limit:{tenantId}:{resource}` キー (管理 API から動的変更可能)
  2. 環境変数 `REDIS_DEFAULT_QUOTA_LIMIT` のデフォルト値
- **Prometheus 計装**: `platform_quota_checks_total{result,resource}` カウンター

#### processRequestActivity (activities/index.ts)

- `action × resource` の組み合わせで専用ハンドラへディスパッチする拡張ポイント
- 実運用では `handlers` マップに各ドメインの処理を登録する

#### sendNotificationActivity (notificationActivity.ts)

- NATS パブリッシュ (`platform.notifications.{tenantId}`) + HTTP Webhook の 2 バックエンドへ**ベストエフォート**配信
- 詳細は「8. 通知アクティビティ実装」を参照

#### persistRequestActivity (persistenceActivity.ts)

- Prisma ORM (`@prisma/client` カスタム出力パス) を使用して PostgreSQL へ UPSERT
- **v1.4: `PrismaClient` を DI に変更** — モジュールレベルの `const prisma = new PrismaClient()` を廃止し、`createPersistRequestActivity(config, logger, prisma)` のパラメータとして受け取る。これによりユニットテストでモックの注入が容易になった
- **v1.4: `DuplicateRequestError` を追加** — Prisma エラーコード `P2002` (Unique constraint violation) を検出して `DuplicateRequestError` に変換してスロー。Temporal の `nonRetryableErrorTypes` に登録することで不必要なリトライを防ぐ
- SaaS Backend の `PATCH /api/requests/{requestId}/status` へステータスをコールバック (ベストエフォート)
- **OTel スパン**: `db.persist_request` + `http.saas_callback`

### 4.6 gateway.ts — NATS → Temporal ゲートウェイ

- **JetStream ストリーム / 耐久コンシューマーを冪等に作成** (すでに存在する場合はスキップ)
- `AckPolicy.Explicit` で処理完了後のみ ack
- 重複起動検出: `WorkflowExecutionAlreadyStarted` エラーを捕捉して ack (再処理なし)
- `AbortSignal` 経由の graceful shutdown 対応

### 4.7 healthServer.ts — ヘルスチェック

| エンドポイント | 成功 | 失敗 | 用途 |
|---|---|---|---|
| `GET /health/live` | 200 `{"status":"ok"}` | — | K8s Liveness Probe |
| `GET /health/ready` | 200 `{"status":"ok","checks":{...}}` | 503 `{"status":"degraded",...}` | K8s Readiness Probe |

**v1.4 で Readiness チェックを充実させた。** 現在の実装済みチェック対象:

| チェック名 | 確認内容 | タイムアウト |
|---|---|---|
| `opa` | `GET {OPA_BASE_URL}/health` が 200 を返すか | 2 秒 |
| `redis` | `redis.ping()` が `PONG` を返すか | ioredis デフォルト |
| `nats` | `notifNc.isClosed() === false` か | 同期 |
| `temporal` | `Connection.connect()` → `getSystemInfo()` が成功するか | gRPC デフォルト |

レスポンス例:

```json
// 全チェック成功 → 200
{ "status": "ok", "checks": { "opa": true, "redis": true, "nats": true, "temporal": true } }

// temporal 障害 → 503
{ "status": "degraded", "checks": { "opa": true, "redis": true, "nats": true, "temporal": false } }
```

> **K8s 設定推奨**: Readiness チェックの `failureThreshold` は 2〜3 に設定し、一時的な障害でトラフィックが即座に切り離されないようにしてください。

### 4.8 policies/platform.rego — OPA RBAC ポリシー

3 つの `allow` ルールをすべて `default deny` ベースで定義します。

| ルール | 条件 |
|---|---|
| super-admin | `data.platform.users[userId].roles` に `"super-admin"` が含まれる |
| テナント RBAC | ユーザーがテナントに所属 + ロールのパーミッションに `{action, resource}` が含まれる |
| readonly_users | `action == "read"` + テナントの `readonly_users` リストに含まれる |

### 4.9 metrics.ts — Prometheus メトリクス定義 — NEW

`prom-client` のデフォルトレジストリを使用します。  
`collectDefaultMetrics({ prefix: 'platform_nodejs_' })` で Node.js 標準メトリクス (CPU・ヒープ・GC・イベントループ遅延) も自動収集します。

| メトリクス名 | 種別 | ラベル | 説明 |
|---|---|---|---|
| `platform_nats_messages_received_total` | Counter | `subject` | Gateway が受信したメッセージ数 |
| `platform_nats_messages_acked_total` | Counter | — | 正常 ack したメッセージ数 |
| `platform_nats_messages_nak_total` | Counter | — | nak (再配送依頼) したメッセージ数 |
| `platform_nats_dlq_total` | Counter | — | DLQ 転送数 |
| `platform_workflow_started_total` | Counter | `task_queue` | 起動したワークフロー数 |
| `platform_opa_decisions_total` | Counter | `result` (allow/deny) | OPA 判定結果数 |
| `platform_opa_decision_duration_seconds` | Histogram | — | OPA 判定レイテンシ |
| `platform_quota_checks_total` | Counter | `result`, `resource` | クォータチェック結果数 |
| `platform_redis_cache_hits_total` | Counter | `key_prefix` | Redis キャッシュヒット数 |
| `platform_redis_cache_misses_total` | Counter | `key_prefix` | Redis キャッシュミス数 |
| `platform_nodejs_*` | 各種 | — | Node.js 標準メトリクス |

### 4.10 cache.ts — Redis クライアント & ユーティリティ — NEW

`ioredis` を使用します。

| 関数 | 説明 |
|---|---|
| `createRedisClient(url)` | Redis クライアントを生成 (指数バックオフ再接続) |
| `checkAndIncrementQuota(...)` | Lua 原子操作でスライディングウィンドウクォータを管理 |
| `getTenantQuotaLimit(...)` | Redis からテナント別クォータ上限を取得 |
| `setTenantQuotaLimit(...)` | テナント別クォータ上限を設定 |
| `cacheGet(...)` | キャッシュ取得 (ヒット/ミスをメトリクスに記録) |
| `cacheSet(...)` | キャッシュ保存 (オプション TTL) |
| `getServiceFlag(...)` | サービス間共有フラグの取得 |
| `setServiceFlag(...)` | サービス間共有フラグの設定 |
| `deleteServiceFlag(...)` | サービス間共有フラグの削除 |

**Redis キー設計:**

| キー | TTL | 説明 |
|---|---|---|
| `quota:{tenantId}:{userId}:{resource}` | `quotaWindowSeconds` | スライディングウィンドウカウンター |
| `quota_limit:{tenantId}:{resource}` | 設定可能 (デフォルト 24h) | テナント別クォータ上限 |
| `flag:{flagName}` | 設定可能 | サービス間共有フラグ |

### 4.11 metricsServer.ts — Prometheus スクレイプエンドポイント — NEW

`http` モジュールで軽量な HTTP サーバーを起動します。

| エンドポイント | レスポンス | 説明 |
|---|---|---|
| `GET /metrics` | `200 text/plain; version=0.0.4` | Prometheus テキスト形式のメトリクス全件 |
| その他 | `404` | — |

---

### 4.12 設定ファイル上の注意点 (既知の挙動) — NEW

#### OPA: `--diagnostic-addr` フラグ

OPA には `--metrics` という CLI フラグは存在しません。  
Prometheus メトリクスを公開するには、`--diagnostic-addr` で専用の診断アドレスを指定します。

```yaml
# docker-compose.yaml (正)
command:
  - "run"
  - "--server"
  - "--addr=0.0.0.0:8181"         # 認可クエリ用 REST API
  - "--diagnostic-addr=0.0.0.0:8282"  # /metrics, /health を公開
```

- ポート `8181` — 認可クエリ (`POST /v1/data/...`) 専用
- ポート `8282` — `/metrics` (Prometheus) / `/health` (ヘルスチェック) 専用
- Prometheus の `prometheus.yml` では OPA スクレイプ先を `opa:8282` と指定する

#### Vector 0.38: YAML 内の環境変数展開

Vector 0.38 は `${VARIABLE_NAME}` 構文を **コメント行 (`#` で始まる行) を含む YAML 全行** で評価します。  
定義されていない環境変数が1つでも含まれると起動時にエラーになります。

```yaml
# NG: コメント内でも評価される
# connection_string: ${VECTOR_PG_CONNECTION_STRING}

# OK: リテラル文字列で記述する
# connection_string: postgres://user:password@postgres:5432/platform
```

#### Vector 0.38 VRL: `merge()` の可不可

VRL の `merge(target, source)` 関数は **可不可 (fallible)** です。  
ターゲットの型が静的に `Object` と証明できない場合、エラーハンドリングが必要です。

```vrl
# NG: fallible — コンパイルエラー
merge(., parsed)

# OK: infallible variant — エラー時はパニック (処理を中断)
merge!(., parsed)
```

---

## 5. データモデル

### 5.1 PlatformRequest (NATS メッセージ本体)

```json
{
  "requestId": "req-20260430-001",
  "tenantId":  "tenant-a",
  "userId":    "alice",
  "action":    "create",
  "resource":  "orders",
  "payload":   { "amount": 5000, "items": ["item-1"] }
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `requestId` | string | ✔ | グローバルユニーク ID。Temporal workflowId に使用 |
| `tenantId` | string | ✔ | テナント識別子 |
| `userId` | string | ✔ | リクエスト発行ユーザー |
| `action` | string | ✔ | 実行アクション (`create` / `read` / `delete` 等) |
| `resource` | string | ✔ | 対象リソース (`orders` / `users` 等) |
| `payload` | object | — | アクション固有の追加データ |

### 5.2 DB スキーマ例 (PostgreSQL)

```sql
CREATE TABLE platform_requests (
    id          TEXT        PRIMARY KEY,
    tenant_id   TEXT        NOT NULL,
    user_id     TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    resource    TEXT        NOT NULL,
    status      TEXT        NOT NULL,  -- pending / denied / completed / failed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_platform_requests_tenant ON platform_requests(tenant_id, status);
```

### 5.3 OPA RBAC データ構造

```json
{
  "users":   { "<userId>": { "roles": [...], "tenants": [...] } },
  "tenants": { "<tenantId>": { "users": { "<userId>": { "roles": [...] } }, "readonly_users": [...] } },
  "roles":   { "<roleName>": { "permissions": [{ "action": "...", "resource": "..." }] } }
}
```

### 5.4 Redis データ構造 — NEW

| キーパターン | 型 | 説明 | TTL |
|---|---|---|---|
| `quota:{tenantId}:{userId}:{resource}` | String (整数) | ウィンドウ内リクエスト数。Lua の `INCR` で原子的に加算 | `REDIS_QUOTA_WINDOW_SECS` |
| `quota_limit:{tenantId}:{resource}` | String (整数) | テナント別クォータ上限値。管理 API 経由で設定 | 任意 (デフォルト 24h) |
| `flag:{flagName}` | String | サービス間共有フラグ (例: `maintenance`, `feature-xyz`) | 任意 |

---

## 6. 非機能要件への対応

| 要件 | 実装方針 |
|---|---|
| **耐久性** | JetStream WorkQueue 保持 + Temporal イベントソーシング |
| **冪等性** | workflowId = `platform-{requestId}` で重複起動防止 |
| **可観測性** | JSON 構造化ログ (ts / level / component / requestId 相関) + Prometheus メトリクス + Vector ログ集約 |
| **レート制限** | Redis スライディングウィンドウクォータ (テナント × ユーザー × リソース単位) |
| **セキュリティ** | OPA default-deny RBAC、機密情報は環境変数で注入 |
| **スケーラビリティ** | Worker の水平スケール対応 (TaskQueue 共有) |
| **Graceful Shutdown** | SIGTERM → worker.shutdown() + nc.drain() + redis.quit() + メトリクスサーバー停止 |
| **ヘルスチェック** | Liveness / Readiness 分離 (K8s Probe 対応) |

---

## 7. 拡張ポイント

本プラットフォームは以下の 6 つの拡張ポイントを持ちます。  
各ポイントは**他のモジュールへの影響を最小化**して変更できるよう設計されています。

---

### 7.1 ビジネスロジックの追加 (`processRequestActivity`)

**対象ファイル:** `src/product/activities/index.ts`

#### 現在の構造

```typescript
async function processRequestActivity(request: PlatformRequest): Promise<string> {
  return `Processed: ${request.action} on ${request.resource} ...`;
}
```

#### 拡張方法

`action × resource` をキーとする `handlers` マップを定義し、各ドメイン処理を登録します。

```typescript
// src/product/activities/index.ts

import type { PlatformRequest } from '../types.ts';

// ─── ハンドラ型 ──────────────────────────────────────────────────────────────
type RequestHandler = (request: PlatformRequest) => Promise<string>;

// ─── ハンドラマップ ──────────────────────────────────────────────────────────
// キー形式: "{action}:{resource}"
const handlers: Record<string, RequestHandler> = {

  // 注文作成
  'create:orders': async (req) => {
    const { amount, items } = req.payload as { amount: number; items: string[] };
    // DB への注文登録、在庫確認 API 呼び出し 等
    return `Order created: amount=${amount}, items=${items.join(',')}`;
  },

  // 注文取消
  'delete:orders': async (req) => {
    const { orderId } = req.payload as { orderId: string };
    // 取消処理、返金処理 等
    return `Order cancelled: orderId=${orderId}`;
  },

  // ユーザー招待
  'create:users': async (req) => {
    const { email } = req.payload as { email: string };
    // 招待メール送信、仮ユーザー登録 等
    return `User invited: email=${email}`;
  },
};

// ─── アクティビティ本体 ─────────────────────────────────────────────────────
async function processRequestActivity(request: PlatformRequest): Promise<string> {
  const key     = `${request.action}:${request.resource}`;
  const handler = handlers[key];

  if (!handler) {
    // 未対応のアクション/リソースは明示的にエラーにする
    throw new Error(`No handler registered for "${key}"`);
  }

  return handler(request);
}
```

#### 注意事項

- `handlers` マップへの追加のみで新しい処理を組み込めます。既存ハンドラへの影響はありません。
- ハンドラ内で外部 API を呼び出す場合は、タイムアウト制御と例外処理を必ず実装してください。
- Temporal がアクティビティをリトライするため、ハンドラは**冪等**に実装する必要があります。

---

### 7.2 通知手段の変更 (`sendNotificationActivity`)

**対象ファイル:** `src/product/activities/notificationActivity.ts`

#### 現在の構造

```typescript
// スタブ実装 — ログ出力のみ
actLog.info('Notification dispatched', { message: payload.message });
```

#### 拡張方法 — Webhook

```typescript
export function createSendNotificationActivity(config: Config, logger: Logger) {
  return async function sendNotificationActivity(payload: NotificationPayload): Promise<void> {
    // テナントごとの Webhook URL をルックアップ (DB or 設定ファイル)
    const webhookUrl = await resolveWebhookUrl(payload.tenantId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await fetch(webhookUrl, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-Signature': computeHmac(payload), // 送信元検証用
        },
        body:   JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
```

#### 拡張方法 — SendGrid (Email)

```typescript
import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

return async function sendNotificationActivity(payload: NotificationPayload): Promise<void> {
  await sgMail.send({
    to:      await resolveEmailForTenant(payload.tenantId),
    from:    'noreply@example.com',
    subject: `[Platform] Request ${payload.status}: ${payload.requestId}`,
    text:    payload.message,
  });
};
```

#### 拡張方法 — Slack Incoming Webhook

```typescript
return async function sendNotificationActivity(payload: NotificationPayload): Promise<void> {
  const slackUrl = process.env.SLACK_WEBHOOK_URL!;
  const color    = payload.status === 'allowed' ? '#36a64f' : '#e01e5a';

  await fetch(slackUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      attachments: [{
        color,
        title: `Request ${payload.status.toUpperCase()}`,
        text:  payload.message,
        fields: [
          { title: 'RequestId', value: payload.requestId, short: true },
          { title: 'Tenant',    value: payload.tenantId,  short: true },
        ],
      }],
    }),
  });
};
```

#### 注意事項

- 通知の失敗は Temporal がリトライします。外部サービスがダウンしていても最終的に配信されます。
- テナントごとに通知先を切り替える場合は、DB または設定ストアからルックアップする関数を別途実装してください。

---

### 7.3 DB 永続化 (`persistRequestActivity`) — **v1.4 実装済み**

**対象ファイル:** `src/product/activities/persistenceActivity.ts`

v1.4 で Prisma ORM (`@prisma/client` カスタム出力) を使った完全実装に移行した。

#### 主な変更点

- `PrismaClient` を DI パラメータで受け取るよう変更。`createActivities()` が `new PrismaClient()` を生成して渡す
- Prisma エラーコード `P2002` (Unique constraint) を `DuplicateRequestError` に変換し、Temporal の `nonRetryableErrorTypes` に登録
- SaaS Backend の `PATCH /api/requests/{requestId}/status` へステータスをコールバック (ベストエフォート)

#### DuplicateRequestError の設計根拠

同一 `requestId` が 2 回到達するケース (NATS の重複配信) では、2 回目の upsert が PK 制約エラー (`P2002`) を引き起こす可能性がある。  
これはリトライしても解消しないため、`DuplicateRequestError` を `nonRetryableErrorTypes` に登録し、Temporal がリトライを試みないようにしている。

```typescript
export class DuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`Duplicate request ID: ${requestId}`);
    this.name = 'DuplicateRequestError';
  }
}
```

#### 注意事項

- `ON CONFLICT DO UPDATE` により、Temporal のリトライで同じリクエストが再実行されても安全です（冪等）。
- `PrismaClient` のインスタンスは `createActivities()` で 1 つだけ生成されます。アクティビティ関数の中で毎回生成しないでください。

---

### 7.4 Readiness チェック (`healthServer`) — **v1.4 実装済み**

**対象ファイル:** `src/product/index.ts`

v1.4 で `opa` チェックのみから 4 チェックに充実した。実装済みの内容は **4.7 healthServer.ts** セクションを参照。

将来的な追加チェック例 — PostgreSQL ping:

```typescript
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

checks: {
  // ... 既存チェック (opa / redis / nats / temporal) ...

  postgres: async () => {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },
},
```

#### 注意事項

- 各チェック関数は **2 秒以内**に完了するよう `AbortSignal.timeout()` でタイムアウトを設定してください。
- Readiness が `503` になると K8s がトラフィックを切り離すため、一時的な障害で即座に切り離さないよう `failureThreshold` を適切に設定してください（推奨: 2〜3 回）。

---

### 7.5 新しいリソース種別の追加

新しいリソース (`invoices`、`reports` 等) を追加する際の手順です。

#### Step 1: OPA データにパーミッションを追加する

`src/product/policies/platform-data.json` の `roles` セクションに追加します。

```json
"admin": {
  "permissions": [
    { "action": "create", "resource": "invoices" },
    { "action": "read",   "resource": "invoices" },
    { "action": "delete", "resource": "invoices" }
  ]
},
"viewer": {
  "permissions": [
    { "action": "read", "resource": "invoices" }
  ]
}
```

#### Step 2: ポリシーをリロードする

```bash
npx ts-node src/product/policies/loadPolicy.ts
```

プラットフォームの再起動は不要です。

#### Step 3: NATS subject を追加する (必要な場合)

デフォルトの `platform.events.>` はすべての subject を受信します。  
特定 subject だけを受信したい場合は環境変数で絞り込みます。

```bash
export NATS_SUBJECTS=platform.events.orders,platform.events.invoices
```

#### Step 4: ハンドラを実装する

`src/product/activities/index.ts` の `handlers` マップに追加します。

```typescript
const handlers: Record<string, RequestHandler> = {
  // 既存ハンドラ ...

  'create:invoices': async (req) => {
    const { customerId, amount } = req.payload as { customerId: string; amount: number };
    // 請求書作成ロジック (外部 API / DB)
    const invoiceId = `inv-${Date.now()}`;
    return `Invoice ${invoiceId} created for customer ${customerId}, amount=${amount}`;
  },

  'read:invoices': async (req) => {
    const { invoiceId } = req.payload as { invoiceId: string };
    return `Invoice ${invoiceId} retrieved`;
  },
};
```

#### Step 5: 疎通確認

```bash
nats pub platform.events.invoices \
  '{"requestId":"req-inv-001","tenantId":"tenant-a","userId":"alice","action":"create","resource":"invoices","payload":{"customerId":"cust-1","amount":10000}}'
```

Temporal UI (`http://localhost:8080`) でワークフローが `Completed` になることを確認します。

---

### 7.6 OPA ポリシーの変更

#### 7.6.1 新しいロールを追加する

`platform-data.json` に新しいロール定義を追加します。

```json
"roles": {
  "billing-manager": {
    "permissions": [
      { "action": "create", "resource": "invoices" },
      { "action": "read",   "resource": "invoices" },
      { "action": "delete", "resource": "invoices" },
      { "action": "read",   "resource": "reports"  }
    ]
  }
}
```

テナント内のユーザーにロールを付与します。

```json
"tenants": {
  "tenant-a": {
    "users": {
      "dave": { "roles": ["billing-manager"] }
    }
  }
}
```

#### 7.6.2 カスタムポリシールールを追加する

`platform.rego` に新しい `allow` ルールを追加します。  
既存ルールへの影響はなく、新しいルールが `true` を返した場合に許可されます。

```rego
# 例: 同テナントのユーザー同士は互いのプロフィールを読める
allow if {
    input.action   == "read"
    input.resource == "profiles"
    input.tenantId in data.platform.users[input.userId].tenants
}

# 例: 時間帯制限 (UTC 09:00-18:00 のみ許可)
# ※ OPA の time パッケージを使用
import future.keywords.if
allow if {
    input.action == "create"
    hour := time.clock(time.now_ns())[0]
    hour >= 9
    hour < 18
}
```

#### 7.6.3 ポリシー変更の適用フロー

```
1. platform.rego / platform-data.json を編集
       ↓
2. npx ts-node src/product/policies/loadPolicy.ts
       ↓ スモークテスト自動実行
3. 全テストが PASS することを確認
       ↓
4. (オプション) OPA の /v1/data/platform/authz/allow を
   curl / PowerShell で手動検証
       ↓
5. 変更完了 — プラットフォームの再起動不要
```

#### 7.6.4 ポリシーの動作確認コマンド

```powershell
# 新ロール billing-manager が invoices を create できるか
$body = @{
  input = @{
    tenantId = "tenant-a"
    userId   = "dave"
    action   = "create"
    resource = "invoices"
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8181/v1/data/platform/authz/allow `
  -ContentType 'application/json' `
  -Body $body
# 期待値: {"result":true}
```

---

## 8. 通知アクティビティ実装 (v1.3 追加)

> 改訂日: 2026-05-01 (v1.3 — 通知アクティビティ本実装 + DLQ コンシューマー追加)

### 8.1 概要

`sendNotificationActivity` をスタブから**本実装**に置き換えた。  
2 つのバックエンドへ**ベストエフォート**で配信し、どちらが失敗してもワークフローを止めない。

| # | バックエンド | 説明 |
|---|---|---|
| 1 | **NATS パブリッシュ** | `platform.notifications.{tenantId}` へ publish。フロントエンドや他サービスがリアルタイムに受信できる |
| 2 | **HTTP Webhook** | `NOTIFICATION_WEBHOOK_URL` が設定されている場合に Slack / Teams / カスタムエンドポイントへ POST |

### 8.2 NATS 通知の配信フロー

```
sendNotificationActivity(payload)
  │
  ├─ nc.publish('platform.notifications.{tenantId}', JSON.stringify(payload))
  │    └─ サブスクライバー (フロントエンド WebSocket / 他サービス) がリアルタイム受信
  │
  └─ [webhookUrl が設定されている場合]
       fetch(webhookUrl, { method: 'POST', body: JSON.stringify({...}) })
```

NATS 接続 (`notifNc`) は `index.ts` で作成し、DI チェーン経由で渡す:

```
index.ts
  └─ const notifNc = await connect(...)
       ↓
  startWorker(config, logger, redis, notifNc)
       ↓
  createActivities(config, logger, redis, notifNc)
       ↓
  createSendNotificationActivity(config, logger, notifNc)
```

### 8.3 Webhook ペイロード仕様

```json
{
  "service":   "orchestration-platform",
  "requestId": "req-20260501-001",
  "tenantId":  "tenant-a",
  "userId":    "alice",
  "status":    "allowed",
  "message":   "File created: id=req-20260501-001, filename=report.pdf",
  "timestamp": "2026-05-01T10:00:00.000Z"
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `service` | string | 送信元サービス識別子 |
| `requestId` | string | プラットフォームリクエスト ID |
| `tenantId` | string | テナント ID |
| `userId` | string | リクエスト発行ユーザー |
| `status` | string | `"allowed"` / `"denied"` / `"quota-exceeded"` / `"error"` |
| `message` | string | 人間可読な処理結果メッセージ |
| `timestamp` | string | ISO 8601 形式の送信日時 |

### 8.4 新規環境変数

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `NOTIFICATION_NATS_SUBJECT` | `platform.notifications` | 通知 NATS サブジェクトプレフィックス |
| `NOTIFICATION_WEBHOOK_URL` | `""` (空 = 無効) | Slack / Teams / カスタム Webhook URL |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | `5000` | Webhook リクエストタイムアウト (ms) |

### 8.5 OTel スパン — `notification.send`

**トレーサー名:** `platform.notification`

| 属性名 | 値 | 説明 |
|---|---|---|
| `platform.tenant_id` | `payload.tenantId` | テナント ID |
| `platform.user_id` | `payload.userId` | ユーザー ID |
| `platform.request_id` | `payload.requestId` | リクエスト ID |
| `notification.status` | `payload.status` | 通知するステータス |
| `notification.nats.subject` | サブジェクト文字列 | NATS publish 先 |
| `notification.webhook.status_code` | HTTP ステータスコード | Webhook レスポンス (設定時のみ) |

### 8.6 Prometheus メトリクス追加

| メトリクス名 | 種別 | ラベル | 説明 |
|---|---|---|---|
| `platform_notifications_sent_total` | Counter | `status` | 正常 dispatch した通知数 |
| `platform_notifications_failed_total` | Counter | `status` | dispatch に失敗した通知数 (非致命的) |

---

## 9. DLQ コンシューマー (v1.3 追加)

### 9.1 概要

Gateway が不正形式メッセージを `platform.dlq` へ転送していたが、従来は `nc.publish()` による**コアテキストのみの publish** だった。  
今回、DLQ も **JetStream ストリーム (`PLATFORM-DLQ`) に永続化**し、専用の `startDlqConsumer()` プロセスで処理・モニタリングする構成に変更した。

```
Gateway (不正メッセージ検出)
  │
  └─ js.publish('platform.dlq', msg.data)   ← JetStream に永続化 (旧: nc.publish)
          │
          ▼
  PLATFORM-DLQ ストリーム (7 日間保持)
          │
          ▼
  dlqConsumer.ts (耐久コンシューマー: dlq-processor)
    ├─ JSON パース試行 → 構造化 warn ログ
    ├─ dlqProcessedTotal メトリクスインクリメント
    ├─ Webhook アラート送信 (NOTIFICATION_WEBHOOK_URL が設定されている場合)
    └─ ack / 失敗時は nak (JetStream が再配送)
```

### 9.2 DLQ JetStream ストリーム設定

| 設定項目 | 値 | 説明 |
|---|---|---|
| ストリーム名 | `PLATFORM-DLQ` | 環境変数 `NATS_DLQ_STREAM_NAME` で変更可 |
| サブジェクト | `platform.dlq` | 環境変数 `NATS_DLQ_SUBJECT` で変更可 |
| 保持期間 | 7 日間 | 手動調査・再処理バッファ |
| 最大メッセージ数 | 100,000 件 | |
| 耐久コンシューマー | `dlq-processor` | — |

### 9.3 DLQ コンシューマーの処理フロー

```
DLQ メッセージ受信 (seq = N)
  │
  ├─ JSON.parse 試行
  │    ├─ 成功: 構造化フィールドをログに含める
  │    └─ 失敗: { raw: rawText.slice(0, 512) } をログに含める
  │
  ├─ log.warn('DLQ message received', { seq, subject, timestamp, parseError?, payload })
  │
  ├─ dlqProcessedTotal.inc()
  │
  ├─ [NOTIFICATION_WEBHOOK_URL が設定されている場合]
  │    fetch(webhookUrl, {
  │      body: { type: 'dlq_alert', service, seq, subject, timestamp, parseError?, payload }
  │    })
  │    └─ dlqAlertSentTotal.inc({ result: 'success' | 'failure' | 'error' })
  │
  ├─ span.setStatus(OK)
  ├─ msg.ack()
  │
  └─ [例外発生時]
       span.recordException(err) → msg.nak() → JetStream 再配送
```

### 9.4 DLQ アラート Webhook ペイロード

```json
{
  "type":       "dlq_alert",
  "service":    "orchestration-platform",
  "seq":        42,
  "subject":    "platform.dlq",
  "timestamp":  "2026-05-01T10:05:00.000Z",
  "parseError": "Invalid JSON",
  "payload":    { "raw": "malformed data..." }
}
```

### 9.5 OTel スパン — `nats.dlq.process`

**トレーサー名:** `platform.dlq`

| 属性名 | 値 | 説明 |
|---|---|---|
| `messaging.system` | `"nats"` | メッセージングシステム識別 |
| `messaging.destination` | `msg.subject` | DLQ サブジェクト |
| `messaging.message.sequence` | `msg.seq` | JetStream シーケンス番号 |
| `dlq.stream` | ストリーム名 | DLQ ストリーム名 |
| `dlq.parse_error` | `"none"` / エラー文字列 | JSON パースエラー内容 |
| `dlq.seq` | 数値 | シーケンス番号 |
| `dlq.alert.status_code` | HTTP ステータスコード | Webhook 送信結果 (設定時のみ) |

### 9.6 Prometheus メトリクス追加

| メトリクス名 | 種別 | ラベル | 説明 |
|---|---|---|---|
| `platform_dlq_processed_total` | Counter | — | DLQ から取り出して処理したメッセージ数 |
| `platform_dlq_alert_sent_total` | Counter | `result` (success/failure/error) | DLQ 警告 Webhook の送信結果数 |

### 9.7 新規環境変数

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `NATS_DLQ_STREAM_NAME` | `PLATFORM-DLQ` | DLQ JetStream ストリーム名 |

### 9.8 Gateway の変更点

旧実装では DLQ 転送に `nc.publish()` (コア NATS) を使用していたため、DLQ メッセージはメモリ内にしか存在しなかった。  
新実装では `js.publish()` (JetStream) を使用し、ストリームに永続化するよう変更した。

```typescript
// 旧: コア NATS publish (非永続)
nc.publish(config.nats.dlqSubject, msg.data);

// 新: JetStream publish (永続化・再配送対応)
await js.publish(config.nats.dlqSubject, msg.data);
```

また、メインストリーム (`PLATFORM`) 作成後に DLQ ストリーム (`PLATFORM-DLQ`) も冪等に作成するよう変更した。

### 9.9 起動順序とプロセス構成

```
index.ts: Promise.all([
  worker.run(),           // Temporal ワーカー
  startGateway(...),      // NATS → Temporal ゲートウェイ
  startDlqConsumer(...),  // DLQ モニタリングコンシューマー (新規追加)
])
```

3 プロセスは並行実行される。いずれかが終了すると `AbortController` 経由で他にも shutdown シグナルが伝播する。

DLQ Consumer は **独立した NATS 接続**を使用する (Gateway の接続とは別)。

### 9.10 手動 DLQ 確認コマンド

NATS CLI でストリームの状態を確認:

```bash
# ストリームの統計情報
nats stream info PLATFORM-DLQ

# 最新 DLQ メッセージを確認 (ack しない)
nats consumer next PLATFORM-DLQ dlq-processor --count 5

# DLQ メッセージを手動でパージ (調査完了後)
nats stream purge PLATFORM-DLQ
```

---

## 10. 品質改善 (v1.4)

> 改訂日: 2026-05-01 (v1.4)

### 10.1 ヘルスチェック充実 (②)

**変更ファイル:** `src/product/index.ts`

`startHealthServer` の `checks` に `redis` / `nats` / `temporal` の 3 チェックを追加した。

| チェック | 実装 |
|---|---|
| `redis` | `redis.ping()` が `'PONG'` を返すことを確認 |
| `nats` | `notifNc.isClosed() === false` を確認 (同期チェック) |
| `temporal` | `Connection.connect()` → `workflowService.getSystemInfo()` が成功するか確認 |

### 10.2 PK 重複を非リトライ化 (③)

**変更ファイル:** `src/product/activities/persistenceActivity.ts`, `src/product/workflows/platformWorkflow.ts`

#### 背景

NATS JetStream の再配送などで同一 `requestId` が複数回到着すると、2 回目以降の `persistRequestActivity` で Prisma の `P2002` (Unique constraint violation) が発生していた。このエラーはリトライしても解消しないため、Temporal がリトライを繰り返して無駄なアクティビティ実行が発生していた。

#### 対応

1. `persistenceActivity.ts` に `DuplicateRequestError` クラスを追加し、`P2002` を検出した場合にスローする
2. `platformWorkflow.ts` の `nonRetryableErrorTypes` に `'DuplicateRequestError'` を追加

```typescript
// persistenceActivity.ts
export class DuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`Duplicate request ID: ${requestId}`);
    this.name = 'DuplicateRequestError';
  }
}

// P2002 検出
if (err?.code === 'P2002') {
  throw new DuplicateRequestError(request.requestId);
}
```

```typescript
// platformWorkflow.ts
nonRetryableErrorTypes: ['PolicyViolation', 'DuplicateRequestError'],
```

### 10.3 設定バリデーション (④)

**変更ファイル:** `src/product/config.ts`

`loadConfig()` 末尾で `validateConfig(cfg)` を呼び出し、不正な設定を**起動前にフェイルファスト**で検出するようにした。

検査内容は「4.1 config.ts」セクションの表を参照。

### 10.4 補償リトライポリシー分離 (⑥)

**変更ファイル:** `src/product/workflows/platformWorkflow.ts`

`compensateRequestActivity` を独立した `proxyActivities` ブロックで宣言し、通常アクティビティとは異なるリトライポリシーを適用した。

#### 設計根拠

補償 (Saga ロールバック) は以下の理由から通常アクティビティより長いタイムアウトと多いリトライを設定する:

- 補償失敗はデータ不整合に直結するため、できる限りリトライすべき
- 補償対象の外部 API (FileStorageService / UserService) は冪等なので積極リトライが安全
- 補償処理はメインフローより優先度が低くてよいため、より長い待機時間を許容できる

| 設定 | 通常 | 補償 |
|---|---|---|
| `startToCloseTimeout` | 30 秒 | **60 秒** |
| `maximumAttempts` | 3 | **5** |
| `nonRetryableErrorTypes` | `['PolicyViolation', 'DuplicateRequestError']` | `[]` (全エラーでリトライ) |

### 10.5 node-fetch 除去 (⑨)

**変更ファイル:** `src/product/activities/opaActivity.ts`, `src/product/policies/loadPolicy.ts`, `src/product/index.ts`

Node.js 18+ のグローバル `fetch` が利用可能になったため、`node-fetch` パッケージへの依存を除去した。

主な変更点:
- `import fetch from 'node-fetch'` を削除
- `signal` 型キャストの複雑な `unknown as ...` 式が不要になった (`controller.signal` をそのまま渡せる)
- テストの `vi.mock('node-fetch', ...)` を `vi.stubGlobal('fetch', ...)` に変更

### 10.6 PrismaClient DI (⑩)

**変更ファイル:** `src/product/activities/persistenceActivity.ts`, `src/product/activities/index.ts`

#### 背景

`persistenceActivity.ts` でモジュールレベルに `const prisma = new PrismaClient()` があったため、ユニットテスト時にモジュールモック (`vi.mock`) が必要だった。

#### 対応

- `createPersistRequestActivity(config, logger, prisma)` の第 3 引数として `PrismaClient` インスタンスを受け取るよう変更
- `createActivities()` 内で `new PrismaClient()` を 1 回だけ生成して渡す
- テスト側は `vi.mock` が不要になり、`mockPrisma` オブジェクトを直接引数に渡せるようになった

```typescript
// activities/index.ts (変更後)
export function createActivities(config, logger, redis, nc) {
  const prisma = new PrismaClient();        // ← ここで 1 回生成
  return {
    persistRequestActivity: createPersistRequestActivity(config, logger, prisma),
    // ...
  };
}
```

```typescript
// テスト (変更後) — vi.mock 不要
const mockPrisma = { platformRequest: { upsert: mockUpsert } };
persistRequestActivity = mod.createPersistRequestActivity(mockConfig, mockLogger, mockPrisma);
```
