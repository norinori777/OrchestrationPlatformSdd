# オーケストレーションプラットフォーム 運用ガイド

> 対象ディレクトリ: `src/product/`  
> バージョン: 1.2  
> 作成日: 2026-04-30  
> 改訂日: 2026-04-30 (v1.1 — Prometheus / Vector / Redis 追加)  
> 改訂日: 2026-04-30 (v1.2 — OPA diagnostic-addr / Vector VRL 修正)

---

## 1. 前提条件

### 1.1 依存サービス

| サービス | ポート | 用途 |
|---|---|---|
| Temporal Server | 7233 (gRPC) | ワークフロー実行エンジン |
| Temporal UI | 8080 | ワークフロー監視コンソール |
| NATS (JetStream 有効) | 4222 | イベントバス |
| Open Policy Agent | 8181 (REST) | 認可ポリシー評価 |
| Open Policy Agent | 8282 (Diagnostic) | `/metrics` (Prometheus) ・ `/health` 公開 |
| PostgreSQL | 5432 | リクエスト永続化 |
| **Redis** | **6379** | **クォータ管理 / サービスフラグ** |
| **Prometheus** | **9090** | **メトリクス収集・可視化** |
| **Vector** | **8686 (API), 9001 (HTTP)** | **コンテナログ集約パイプライン** |

すべてのサービスは `docker-compose.yaml` で起動できます。

```bash
docker-compose -f docker-compose.yaml up -d
```

### 1.2 Node.js / パッケージ

```bash
node -v   # v20 以上を推奨
npm install
```

---

## 2. 初期セットアップ

### 2.1 OPA へポリシーをロード

プラットフォームを初めて起動する前に、OPA へ Rego ポリシーと RBAC データをロードします。

```bash
npx ts-node src/product/policies/loadPolicy.ts
```

成功した場合、以下のような出力が表示されます。

```
Loading platform policy to OPA at http://localhost:8181…
✔  Policy loaded: platform/authz
✔  RBAC data loaded: data.platform

Running smoke tests…
  ✔  alice@tenant-a create:orders → true (expected true)
  ✔  bob@tenant-a read:orders → true (expected true)
  ✔  bob@tenant-a delete:orders → false (expected false)
  ✔  charlie@tenant-b read:orders → true (expected true)
  ✔  charlie@tenant-b create:orders → false (expected false)
  ✔  super-admin@tenant-a delete:users → true (expected true)

6/6 tests passed
```

### 2.2 PostgreSQL テーブルの作成

`persistenceActivity.ts` の DB 永続化を有効化する場合、事前にテーブルを作成します。

```sql
CREATE TABLE platform_requests (
    id          TEXT        PRIMARY KEY,
    tenant_id   TEXT        NOT NULL,
    user_id     TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    resource    TEXT        NOT NULL,
    status      TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_platform_requests_tenant ON platform_requests(tenant_id, status);
```

---

## 3. 環境変数の設定

本番環境では `.env` ファイルではなく、**K8s Secret / AWS SSM Parameter Store / HashiCorp Vault** で注入してください。

### 3.1 最小構成 (ローカル開発)

```bash
# Temporal
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_NAMESPACE=default
export TEMPORAL_TASK_QUEUE=platform-task-queue

# NATS
export NATS_SERVERS=localhost:4222
export NATS_STREAM_NAME=PLATFORM
export NATS_SUBJECTS=platform.events.>
export NATS_CONSUMER_NAME=platform-worker
export NATS_DLQ_SUBJECT=platform.dlq
export NATS_MAX_DELIVER=3
export NATS_ACK_WAIT_SECS=30

# OPA
export OPA_BASE_URL=http://localhost:8181
export OPA_POLICY_PATH=platform/authz/allow
export OPA_TIMEOUT_MS=5000
export OPA_MAX_RETRIES=3

# Redis
export REDIS_URL=redis://localhost:6379
export REDIS_QUOTA_WINDOW_SECS=3600
export REDIS_DEFAULT_QUOTA_LIMIT=1000

# Prometheus メトリクスサーバー
export METRICS_PORT=9100
export METRICS_HOST=0.0.0.0

# Health
export HEALTH_PORT=3000

# Log
export LOG_LEVEL=info
export SERVICE_NAME=orchestration-platform
```

### 3.2 本番推奨設定

```bash
# Temporal (TLS 有効の場合)
export TEMPORAL_ADDRESS=temporal.internal.example.com:7233
export TEMPORAL_NAMESPACE=production

# NATS クラスター
export NATS_SERVERS=nats1:4222,nats2:4222,nats3:4222
export NATS_MAX_DELIVER=5
export NATS_ACK_WAIT_SECS=60

# OPA
export OPA_TIMEOUT_MS=3000
export OPA_MAX_RETRIES=3

# Redis (咨計: maxmemory 1GB, allkeys-lru)
export REDIS_URL=redis://redis.internal.example.com:6379
export REDIS_QUOTA_WINDOW_SECS=3600
export REDIS_DEFAULT_QUOTA_LIMIT=5000

# Prometheus
export METRICS_PORT=9100

# ログ
export LOG_LEVEL=warn
```

---

## 4. 起動・停止

### 4.1 プラットフォームの起動

```bash
npx ts-node src/product/index.ts
```

起動ログ例 (JSON 形式):

```json
{"ts":"2026-04-30T09:00:00Z","level":"info","service":"orchestration-platform","component":"main","msg":"Orchestration platform starting","temporal":"localhost:7233","nats":"localhost:4222","redis":"redis://localhost:6379","metrics":"0.0.0.0:9100"}
{"ts":"2026-04-30T09:00:00Z","level":"info","service":"orchestration-platform","component":"metrics-server","msg":"Metrics server started","port":9100,"endpoint":"http://0.0.0.0:9100/metrics"}
{"ts":"2026-04-30T09:00:01Z","level":"info","service":"orchestration-platform","component":"main","msg":"Redis connected"}
{"ts":"2026-04-30T09:00:01Z","level":"info","service":"orchestration-platform","component":"health","msg":"Health server started","port":3000}
{"ts":"2026-04-30T09:00:01Z","level":"info","service":"orchestration-platform","component":"worker","msg":"Worker created","taskQueue":"platform-task-queue"}
{"ts":"2026-04-30T09:00:01Z","level":"info","service":"orchestration-platform","component":"gateway","msg":"Gateway listening for platform events"}
```

### 4.2 Graceful Shutdown

`SIGTERM` または `SIGINT` (`Ctrl+C`) を送信するとシャットダウンシーケンスが実行されます。

```
SIGTERM 受信
  ├─ Worker: 実行中のタスクを完了後に停止 (worker.shutdown())
  ├─ Gateway: メッセージ受信を停止 (messages.stop())
  ├─ NATS: バッファをフラッシュして切断 (nc.drain())
  ├─ Redis: 接続をクローズ (redis.quit())
  ├─ Metrics Server: HTTP サーバーをクローズ
  └─ Health Server: HTTP サーバーをクローズ
```

---

## 5. イベントの送信

NATS subject `platform.events.{resource}` へ以下の JSON メッセージを publish します。

### 5.1 メッセージ形式

```json
{
  "requestId": "req-20260430-001",
  "tenantId":  "tenant-a",
  "userId":    "alice",
  "action":    "create",
  "resource":  "orders",
  "payload":   {
    "amount": 5000,
    "items":  ["item-1", "item-2"]
  }
}
```

| フィールド | 必須 | 注意事項 |
|---|---|---|
| `requestId` | ✔ | グローバルユニークであること。UUID v4 推奨。重複すると冪等処理される |
| `tenantId` | ✔ | OPA データの `data.platform.tenants` に存在するキー |
| `userId` | ✔ | OPA データの `data.platform.users` に存在するキー |
| `action` | ✔ | OPA ポリシーの `permissions[].action` と一致する文字列 |
| `resource` | ✔ | OPA ポリシーの `permissions[].resource` と一致する文字列 |
| `payload` | — | ドメイン固有の追加データ |

### 5.2 送信例 (Node.js / NATS CLI)

**TypeScript:**

```typescript
import { connect, StringCodec } from 'nats';

const nc = await connect({ servers: 'localhost:4222' });
const sc = StringCodec();

const request = {
  requestId: `req-${Date.now()}`,
  tenantId:  'tenant-a',
  userId:    'alice',
  action:    'create',
  resource:  'orders',
  payload:   { amount: 5000 },
};

nc.publish('platform.events.orders', sc.encode(JSON.stringify(request)));
await nc.flush();
await nc.close();
```

**NATS CLI:**

```bash
nats pub platform.events.orders \
  '{"requestId":"req-001","tenantId":"tenant-a","userId":"alice","action":"create","resource":"orders","payload":{}}'
```

---

## 6. ヘルスチェック

### 6.1 エンドポイント

| エンドポイント | 用途 | 成功レスポンス | 失敗レスポンス |
|---|---|---|---|
| `GET /health/live` | Liveness Probe | `200 {"status":"ok"}` | — (常に200) |
| `GET /health/ready` | Readiness Probe | `200 {"status":"ok","checks":{"opa":true}}` | `503 {"status":"degraded","checks":{"opa":false}}` |

### 6.2 確認コマンド

```bash
# Liveness
curl http://localhost:3000/health/live

# Readiness
curl http://localhost:3000/health/ready
```

### 6.3 K8s Probe 設定例

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 2
```

---

## 7. ワークフローの監視

### 7.1 Temporal UI

ブラウザで `http://localhost:8080` を開きます。  
以下の情報を確認できます。

- ワークフロー一覧・実行状態 (Running / Completed / Failed / Terminated)
- ワークフローの詳細イベント履歴 (各ステップのタイムスタンプ・入出力)
- アクティビティの失敗とリトライ履歴

### 7.2 Temporal CLI でのステータス確認

```bash
# ワークフロー一覧 (実行中)
temporal workflow list --query 'ExecutionStatus = "Running"'

# 特定のワークフロー詳細
temporal workflow describe --workflow-id platform-req-001

# クエリでステータス取得 (getStatus Query)
temporal workflow query \
  --workflow-id platform-req-001 \
  --query-type getStatus
```

### 7.3 ワークフローのキャンセル

```bash
# cancel Signal を送信
temporal workflow signal \
  --workflow-id platform-req-001 \
  --name cancel
```

---

## 8. OPA ポリシーの管理

### 8.1 ポリシーの更新手順

1. `src/product/policies/platform.rego` を編集
2. `src/product/policies/platform-data.json` を編集 (ユーザー・ロール・テナントの追加/変更)
3. 更新スクリプトを実行

```bash
npx ts-node src/product/policies/loadPolicy.ts
```

プラットフォームの再起動は不要です。OPA はホットリロードします。

### 8.2 ユーザーへのロール付与

`platform-data.json` を以下の手順で更新します。

```json
{
  "users": {
    "new-user": {
      "roles": [],
      "tenants": ["tenant-a"]
    }
  },
  "tenants": {
    "tenant-a": {
      "users": {
        "new-user": {
          "roles": ["viewer"]
        }
      }
    }
  }
}
```

定義済みロールとパーミッション:

| ロール | 許可アクション | 許可リソース |
|---|---|---|
| `super-admin` | すべて | すべて |
| `admin` | read / create / delete | orders / users |
| `operator` | read / create | orders |
| `viewer` | read | orders / users |

### 8.3 OPA ポリシーの動作確認

```powershell
# alice (tenant-a の admin) が orders を create できるか
$body = @{ input = @{ tenantId = "tenant-a"; userId = "alice"; action = "create"; resource = "orders" } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:8181/v1/data/platform/authz/allow -ContentType 'application/json' -Body $body
# 期待値: {"result":true}

# bob (tenant-a の viewer) が orders を delete できないか
$body = @{ input = @{ tenantId = "tenant-a"; userId = "bob"; action = "delete"; resource = "orders" } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:8181/v1/data/platform/authz/allow -ContentType 'application/json' -Body $body
# 期待値: {"result":false}
```

---

## 9. Dead Letter Queue (DLQ) の処理

`max_deliver` 回の再配送後に成功しなかったメッセージ、または不正形式のメッセージは `platform.dlq` subject へ転送されます。

### 9.1 DLQ メッセージの確認

```bash
# NATS CLI でサブスクライブ
nats sub platform.dlq
```

### 9.2 DLQ メッセージの再処理フロー

1. DLQ メッセージを取り出して原因を調査 (不正形式 / OPA 障害 / Temporal 障害)
2. 原因を解消する
3. 必要に応じて手動でメッセージを再送する

```bash
# 手動再送 (requestId を新規生成して重複を避ける)
nats pub platform.events.orders '{"requestId":"req-retry-001",...}'
```

---

## 10. ログの確認

プラットフォームは JSON 形式でログを出力します。  
`jq` コマンドでフィルタリングできます。

```bash
# エラーログのみ表示
npx ts-node src/product/index.ts 2>&1 | jq 'select(.level == "error")'

# 特定の requestId に関するログを追跡
npx ts-node src/product/index.ts 2>&1 | jq 'select(.requestId == "req-001")'

# コンポーネント別フィルタ
npx ts-node src/product/index.ts 2>&1 | jq 'select(.component == "gateway")'
```

本番環境では Fluentd / Datadog / CloudWatch Logs 等でログを収集・検索します。

---

## 11. トラブルシューティング

### 11.1 起動に失敗する

| 症状 | 確認事項 |
|---|---|
| `NATS connection refused` | `docker-compose up -d` で NATS が起動しているか確認 |
| `Temporal connection failed` | Temporal Server が `:7233` で起動しているか確認 |
| `Redis connection refused` | `docker compose up redis -d` で Redis が起動しているか確認 |
| `Env var X must be a number` | 環境変数の値が数値か確認 |

### 11.2 ワークフローが `Failed` になる

1. Temporal UI でワークフローを開き、失敗したアクティビティを確認する
2. エラーメッセージから原因を特定する

| アクティビティ | 主な原因 |
|---|---|
| `evaluatePolicyActivity` | OPA が起動していない / ポリシーがロードされていない |
| `processRequestActivity` | ビジネスロジックのバグ |
| `persistRequestActivity` | DB 接続エラー / テーブルが存在しない |
| `sendNotificationActivity` | Webhook エンドポイント障害 |

### 11.3 メッセージが DLQ へ送られる

- `requestId` / `tenantId` / `userId` フィールドが欠如していないか確認する
- JSON が正しい形式か確認する

### 11.4 OPA が常に `false` を返す

1. ポリシーとデータがロードされているか確認する

```bash
curl http://localhost:8181/v1/policies
curl http://localhost:8181/v1/data/platform
```

2. `platform-data.json` で `userId` / `tenantId` / `action` / `resource` が正しいか確認する
3. `loadPolicy.ts` を再実行する

### 11.5 重複リクエストが処理される

- `requestId` がユニークであることを確認する
- UUID v4 の使用を推奨: `crypto.randomUUID()`

---

## 12. ビジネスロジックの追加方法

新しいリソース種別 (`invoices` 等) に対応する手順です。

**1. OPA データを更新する**

`platform-data.json` の `roles` に新しいパーミッションを追加します:

```json
"admin": {
  "permissions": [
    { "action": "create", "resource": "invoices" },
    { "action": "read",   "resource": "invoices" }
  ]
}
```

**2. ポリシーをリロードする**

```bash
npx ts-node src/product/policies/loadPolicy.ts
```

**3. ハンドラを実装する**

`src/product/activities/index.ts` の `processRequestActivity` にハンドラを追加します:

```typescript
const handlers: Record<string, (req: PlatformRequest) => Promise<string>> = {
  'create:invoices': async (req) => {
    // 請求書作成ロジック
    return `Invoice created for tenant ${req.tenantId}`;
  },
  'read:invoices': async (req) => {
    // 請求書取得ロジック
    return `Invoice fetched`;
  },
};

async function processRequestActivity(request: PlatformRequest): Promise<string> {
  const handler = handlers[`${request.action}:${request.resource}`];
  if (!handler) throw new Error(`No handler for ${request.action}:${request.resource}`);
  return handler(request);
}
```

**4. イベントを送信してテストする**

```bash
nats pub platform.events.invoices \
  '{"requestId":"req-inv-001","tenantId":"tenant-a","userId":"alice","action":"create","resource":"invoices","payload":{"amount":10000}}'
```

---

## 13. Prometheus メトリクスの監視

### 13.1 メトリクスエンドポイントの確認

```bash
# プラットフォームのメトリクスを手動確認
curl http://localhost:9100/metrics

# Prometheus UI でクエリ実行
# ブラウザで http://localhost:9090 を開く
```

### 13.2 主要なメトリクスと推奨アラート

#### NATS JetStream

| メトリクス | PromQL 例 | 推奨アラート条件 |
|---|---|---|
| メッセージ受信レート | `rate(platform_nats_messages_received_total[5m])` | 急激な増加/減少 |
| DLQ 転送数 | `increase(platform_nats_dlq_total[1h])` | > 0 でアラート |
| nak レート | `rate(platform_nats_messages_nak_total[5m])` | > 0.1/s で警告 |
| ack 成功率 | `rate(platform_nats_messages_acked_total[5m]) / rate(platform_nats_messages_received_total[5m])` | < 0.95 で警告 |

#### OPA 認可

| メトリクス | PromQL 例 | 推奨アラート条件 |
|---|---|---|
| 拒否率 | `rate(platform_opa_decisions_total{result="deny"}[5m]) / rate(platform_opa_decisions_total[5m])` | > 0.5 で警告 |
| 判定レイテンシ p95 | `histogram_quantile(0.95, rate(platform_opa_decision_duration_seconds_bucket[5m]))` | > 0.1s で警告 |

#### Redis クォータ

| メトリクス | PromQL 例 | 推奨アラート条件 |
|---|---|---|
| クォータ超過レート | `rate(platform_quota_checks_total{result="exceeded"}[5m])` | > 0 で通知 |
| テナント別超過 | `sum by(resource) (rate(platform_quota_checks_total{result="exceeded"}[5m]))` | リソース別ダッシュボード |

#### Node.js プロセス

| メトリクス | PromQL 例 | 推奨アラート条件 |
|---|---|---|
| ヒープ使用率 | `platform_nodejs_process_heap_bytes{type="used"} / platform_nodejs_process_heap_bytes{type="total"}` | > 0.85 で警告 |
| イベントループ遅延 | `platform_nodejs_eventloop_lag_seconds` | > 0.1s で警告 |

### 13.3 Prometheus の設定確認

```bash
# 設定ファイルの検証
docker exec orchestrationplatformsdd-prometheus-1 \
  promtool check config /etc/prometheus/prometheus.yml

# スクレイプターゲットの状態確認 (Prometheus UI)
# http://localhost:9090/targets
```

### 13.4 スクレイプターゲット一覧

| ジョブ名 | スクレイプ先 | 間隔 |
|---|---|---|
| `orchestration-platform` | `host.docker.internal:9100/metrics` | 10s |
| `opa` | `opa:8282/metrics` | 15s |
| `nats` | `nats:8222/metrics` | 15s |
| `vector` | `vector:8686/metrics` | 15s |
| `prometheus` | `localhost:9090/metrics` | 15s |

---

## 14. Vector によるログ管理

### 14.1 Vector の動作確認

```bash
# Vector のステータス確認
docker compose logs vector --tail=50

# Vector の組み込みメトリクス確認
curl http://localhost:8686/metrics
```

### 14.2 ログソース

Vector は以下のソースからログを収集します:

| ソース名 | 種別 | 対象 |
|---|---|---|
| `docker_logs` | Docker コンテナログ | temporal / nats / opa / postgres / redis |
| `http_server` | HTTP 受信 (`:9001`) | アプリケーション / 外部システムからの直接送信 |

### 14.3 ログパイプライン

```
docker_logs / http_server
  ↓ parse_json_logs   : JSON 文字列をパースし service_name フィールドを付与
  ↓ filter_noise      : level=debug のログを除外
  ↓ add_metadata      : environment=local タグを付与
  ↓ console_out       : JSON 形式で stdout へ出力
```

### 14.4 本番への拡張 — ログストレージへのシンク

`config/vector.yaml` のシンクセクションを以下のいずれかに変更します。

**Elasticsearch:**

```yaml
sinks:
  elasticsearch_out:
    type: elasticsearch
    inputs: [add_metadata]
    endpoints: ["https://es.internal.example.com:9200"]
    index: "platform-logs-%Y.%m.%d"
    auth:
      strategy: basic
      user: "${ES_USER}"
      password: "${ES_PASSWORD}"
```

**AWS CloudWatch Logs:**

```yaml
sinks:
  cloudwatch_out:
    type: aws_cloudwatch_logs
    inputs: [add_metadata]
    group_name: "/platform/orchestration"
    stream_name: "{{ host }}"
    region: "ap-northeast-1"
```

**HTTP (Datadog / Loki 等):**

```yaml
sinks:
  http_out:
    type: http
    inputs: [add_metadata]
    uri: "https://http-intake.logs.datadoghq.com/api/v2/logs"
    encoding:
      codec: json
    headers:
      DD-API-KEY: "${DD_API_KEY}"
```

### 14.5 アプリケーションから直接ログを送信する

Vector の HTTP ソース (`:9001`) へ JSON を POST することで、コンテナ外のサービスからもログを集約できます。

```bash
curl -X POST http://localhost:9001 \
  -H "Content-Type: application/json" \
  -d '{"level":"info","service":"external-app","msg":"Integration test completed"}'
```

---

## 15. Redis クォータ管理

### 15.1 クォータの仕組み

リクエストは OPA 認可の通過後に Redis でクォータチェックされます。  
カウンターキーは `quota:{tenantId}:{userId}:{resource}` で、ウィンドウ経過後に自動失効します。

```
ウィンドウ開始 (EXPIRE 設定)
  │
  ├─ リクエスト 1 → INCR → 1  (allowed)
  ├─ リクエスト 2 → INCR → 2  (allowed)
  ├─ ...
  ├─ リクエスト 1000 → INCR → 1000  (allowed, 上限到達)
  ├─ リクエスト 1001 → INCR → 1001  (quota-exceeded → denied)
  └─ ウィンドウ終了 → キー TTL 切れ → 次のウィンドウへ
```

### 15.2 テナント別クォータ上限の設定

デフォルト値 (`REDIS_DEFAULT_QUOTA_LIMIT`) を超えるテナントには個別上限を設定します。

```bash
# Redis CLI でテナント別上限を設定 (1 時間 = 86400 秒で失効する例)
redis-cli SET quota_limit:tenant-a:orders 5000 EX 86400

# 永続設定 (TTL なし)
redis-cli SET quota_limit:tenant-premium:orders 100000
```

**PowerShell (ioredis 経由で設定する場合):**

```typescript
import { createRedisClient, setTenantQuotaLimit } from './src/product/cache.ts';
const redis = createRedisClient('redis://localhost:6379');
await setTenantQuotaLimit(redis, 'tenant-a', 'orders', 5000);
await redis.quit();
```

### 15.3 クォータカウンターの確認・リセット

```bash
# 特定ユーザーの現在のカウンターを確認
redis-cli GET quota:tenant-a:alice:orders

# TTL (残り秒数) を確認
redis-cli TTL quota:tenant-a:alice:orders

# カウンターをリセット (緊急時)
redis-cli DEL quota:tenant-a:alice:orders
```

### 15.4 サービスフラグの操作

```bash
# メンテナンスモードを有効化 (1 時間後に自動失効)
redis-cli SET flag:maintenance "true" EX 3600

# メンテナンスモードを即時解除
redis-cli DEL flag:maintenance

# フラグの一覧確認
redis-cli KEYS "flag:*"
```

### 15.5 Redis の健全性確認

```bash
# Redis の疎通確認
redis-cli -u $REDIS_URL PING
# 期待値: PONG

# メモリ使用状況
redis-cli -u $REDIS_URL INFO memory | grep used_memory_human

# クォータキーの件数確認
redis-cli -u $REDIS_URL KEYS "quota:*" | Measure-Object -Line
```

---

## 16. トラブルシューティング (追記)

### 16.1 メトリクスサーバーが起動しない

| 症状 | 確認事項 |
|---|---|
| `port 9100 already in use` | 他プロセスがポートを使用中。`METRICS_PORT` 環境変数で変更 |
| `GET /metrics` が 500 を返す | prom-client の初期化エラー。起動ログを確認 |

### 16.2 Prometheus がメトリクスを収集できない

1. `http://localhost:9090/targets` でターゲットの状態が `UP` か確認する
2. `orchestration-platform` ターゲットが `DOWN` の場合:
   - プラットフォームが起動しているか確認: `curl http://localhost:9100/metrics`
   - Prometheus コンテナが `host.docker.internal` を名前解決できるか確認:
     ```bash
     docker exec orchestrationplatformsdd-prometheus-1 \
       wget -q -O- http://host.docker.internal:9100/metrics | head -5
     ```

### 16.3 Redis 接続エラー

| 症状 | 確認事項 |
|---|---|
| `Redis error: connect ECONNREFUSED` | Redis コンテナが起動しているか確認。`docker compose up redis -d` |
| `Redis error: WRONGTYPE` | キーの型が不正。`redis-cli DEL <key>` で削除して再試行 |
| クォータが常に exceeded | カウンターが想定外に大きい。`redis-cli DEL quota:...` でリセット |

### 16.4 クォータ超過によるリクエスト拒否

```bash
# Prometheus でクォータ超過率を確認
# http://localhost:9090 で以下クエリを実行:
# rate(platform_quota_checks_total{result="exceeded"}[5m])

# 特定テナントの現在カウンターを確認
redis-cli GET quota:<tenantId>:<userId>:<resource>

# 上限値を引き上げる
redis-cli SET quota_limit:<tenantId>:<resource> <newLimit> EX 86400
```

### 16.5 Vector がログを収集しない

```bash
# Vector のログを確認
docker compose logs vector

# Docker ソケットのマウント確認
docker inspect orchestrationplatformsdd-vector-1 | \
  ConvertFrom-Json | Select-Object -ExpandProperty Mounts
```
### 16.6 Vector 起動時の環境変数エラー

Vector 0.38 は YAML のコメント行を含む全行で `${VARIABLE_NAME}` 構文を展開します。
定義されていない環境変数が含まれると起動時に以下のエラーが発生します。

```
error: environment variable not found: VECTOR_PG_CONNECTION_STRING
```

**解決策:** `config/vector.yaml` のコメント含む全行から `${...}` 構文を削除し、リテラル文字列で記述する。

```yaml
# NG: コメント内でもエラーになる
# connection_string: ${VECTOR_PG_CONNECTION_STRING}

# OK: リテラル文字列
# connection_string: postgres://user:password@postgres:5432/platform
```

### 16.7 Vector VRL の `merge()` エラー

Vector 0.38 の VRL で `merge(., parsed)` を使用するとコンパイル時に以下のエラーが発生します。

```
error: the function 'merge' is fallible and its error must be handled
```

**解決策:** `!` 付きの非可不可 variant `merge!()` を使用する。

```vrl
# NG
merge(., parsed)

# OK
merge!(., parsed)
```

### 16.8 OPA `--metrics` フラグエラー

OPA を `--metrics` フラグ付きで起動すると以下のエラーが発生します。

```
Error: unknown flag: --metrics
```

OPA には `--metrics` CLI フラグは存在しません。  
Prometheus メトリクスは `--diagnostic-addr` で指定したアドレスに自動的に公開されます。

**解決策 (docker-compose.yaml):**

```yaml
# NG
command: ["run", "--server", "--metrics", ...]

# OK
command: ["run", "--server", "--addr=0.0.0.0:8181", "--diagnostic-addr=0.0.0.0:8282"]
ports:
  - "8181:8181"  # REST API
  - "8282:8282"  # /metrics, /health
```

**解決策 (prometheus.yml):**

```yaml
# NG
- targets: ["opa:8181"]

# OK
- targets: ["opa:8282"]
```