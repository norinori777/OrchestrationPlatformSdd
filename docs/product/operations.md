# オーケストレーションプラットフォーム 運用ガイド

> 対象ディレクトリ: `src/product/`  
> バージョン: 1.0  
> 作成日: 2026-04-30

---

## 1. 前提条件

### 1.1 依存サービス

| サービス | ポート | 用途 |
|---|---|---|
| Temporal Server | 7233 (gRPC) | ワークフロー実行エンジン |
| Temporal UI | 8080 | ワークフロー監視コンソール |
| NATS (JetStream 有効) | 4222 | イベントバス |
| Open Policy Agent | 8181 (REST) | 認可ポリシー評価 |
| PostgreSQL | 5432 | リクエスト永続化 |

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
{"ts":"2026-04-30T09:00:00Z","level":"info","service":"orchestration-platform","component":"main","msg":"Orchestration platform starting","temporal":"localhost:7233","nats":"localhost:4222"}
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
