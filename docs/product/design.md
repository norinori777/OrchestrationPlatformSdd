# オーケストレーションプラットフォーム 設計書

> 対象ディレクトリ: `src/product/`  
> バージョン: 1.0  
> 作成日: 2026-04-30

---

## 1. 目的・スコープ

本プラットフォームは、複数の SaaS テナントが共有する**イベント駆動型のオーケストレーション基盤**です。  
以下の責務を一元的に担います。

- NATS JetStream によるイベントの**耐久受信・再配送**
- Open Policy Agent (OPA) による**テナント RBAC 認可**
- Temporal による**ワークフローのステート管理と信頼性保証**
- PostgreSQL による**リクエスト永続化**
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
│       ├── processRequestActivity  (ドメインロジック)                   │
│       ├── sendNotificationActivity (Webhook/Email)                   │
│       └── persistRequestActivity  (PostgreSQL)                       │
└──────────────────────────────────────────────────────────────────────┘
                            │
           ┌────────────────┼──────────────────┐
           ▼                ▼                  ▼
    ┌─────────────┐  ┌───────────┐    ┌──────────────┐
    │ OPA         │  │ PostgreSQL│    │ 通知先        │
    │ :8181       │  │ :5432     │    │ (Webhook 等)  │
    └─────────────┘  └───────────┘    └──────────────┘

      Health Server :3000
      GET /health/live   → 200
      GET /health/ready  → 200 / 503
```

### 2.2 ファイル構成

```
src/product/
├── config.ts                   設定ロード (環境変数ベース)
├── logger.ts                   構造化 JSON ロガー
├── types.ts                    共有型定義
├── worker.ts                   Temporal ワーカー起動
├── gateway.ts                  NATS → Temporal ゲートウェイ
├── healthServer.ts             HTTP ヘルスチェックサーバー
├── index.ts                    メインエントリポイント
├── workflows/
│   └── platformWorkflow.ts    メインワークフロー定義
├── activities/
│   ├── index.ts               アクティビティレジストリ
│   ├── opaActivity.ts         OPA ポリシー評価
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
      ├─ Step 3: processRequestActivity(request)
      │           → ドメインロジック実行
      ├─ Step 4: sendNotificationActivity("allowed")
      ├─ Step 5: persistRequestActivity(request, "completed")
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

---

## 4. モジュール設計

### 4.1 config.ts — 設定管理

環境変数から設定を読み込み、型付き `Config` オブジェクトを返します。  
数値変換に失敗した場合は起動時に即座にエラーをスローします（フェイルファスト）。

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
| `NATS_MAX_DELIVER` | `3` | 最大再配送回数 |
| `NATS_ACK_WAIT_SECS` | `30` | Ack タイムアウト (秒) |
| `OPA_BASE_URL` | `http://localhost:8181` | OPA REST API ベース URL |
| `OPA_POLICY_PATH` | `platform/authz/allow` | ポリシーデータパス |
| `OPA_TIMEOUT_MS` | `5000` | OPA リクエストタイムアウト (ms) |
| `OPA_MAX_RETRIES` | `3` | OPA リトライ最大回数 |
| `HEALTH_PORT` | `3000` | ヘルスチェックサーバーポート |
| `HEALTH_HOST` | `0.0.0.0` | ヘルスチェックサーバーバインドアドレス |
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
| `PlatformResponse` | ワークフローの最終応答 |
| `PolicyInput` | OPA への認可クエリ入力 |
| `NotificationPayload` | 通知アクティビティへの入力 |
| `RequestStatus` | DB に記録するリクエストステータス (`pending` / `denied` / `completed` / `failed`) |

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
  ├─ denied    → denied
  └─ allowed   → processing → notifying → completed
```

### 4.5 activities/ — アクティビティ群

#### evaluatePolicyActivity (opaActivity.ts)

- OPA REST API `POST /v1/data/{policyPath}` を呼び出す
- `AbortController` によるタイムアウト制御
- 独自指数バックオフリトライ (1s, 2s, 3s…)
- Temporal のリトライとの二重化を避けるため、アクティビティ内でリトライを完結させる設計

#### processRequestActivity (activities/index.ts)

- `action × resource` の組み合わせで専用ハンドラへディスパッチする拡張ポイント
- 実運用では `handlers` マップに各ドメインの処理を登録する

#### sendNotificationActivity (notificationActivity.ts)

- 実装は差し替え可能なスタブ構造
- Webhook / SendGrid / Slack Incoming Webhook 等に置き換える

#### persistRequestActivity (persistenceActivity.ts)

- PostgreSQL `UPSERT` の SQL 雛形を内包
- `pg` パッケージを追加して実装する

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

Readiness チェック対象 (初期実装): OPA `/health` エンドポイント疎通確認  
追加チェック例: Temporal 接続確認・PostgreSQL ping

### 4.8 policies/platform.rego — OPA RBAC ポリシー

3 つの `allow` ルールをすべて `default deny` ベースで定義します。

| ルール | 条件 |
|---|---|
| super-admin | `data.platform.users[userId].roles` に `"super-admin"` が含まれる |
| テナント RBAC | ユーザーがテナントに所属 + ロールのパーミッションに `{action, resource}` が含まれる |
| readonly_users | `action == "read"` + テナントの `readonly_users` リストに含まれる |

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

---

## 6. 非機能要件への対応

| 要件 | 実装方針 |
|---|---|
| **耐久性** | JetStream WorkQueue 保持 + Temporal イベントソーシング |
| **冪等性** | workflowId = `platform-{requestId}` で重複起動防止 |
| **可観測性** | JSON 構造化ログ (ts / level / component / requestId 相関) |
| **セキュリティ** | OPA default-deny RBAC、機密情報は環境変数で注入 |
| **スケーラビリティ** | Worker の水平スケール対応 (TaskQueue 共有) |
| **Graceful Shutdown** | SIGTERM → worker.shutdown() + nc.drain() |
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

### 7.3 DB 永続化の有効化 (`persistRequestActivity`)

**対象ファイル:** `src/product/activities/persistenceActivity.ts`

#### 手順

**Step 1: パッケージを追加する**

```bash
npm install pg
npm install -D @types/pg
```

**Step 2: 接続プールを初期化する**

```typescript
import pg from 'pg';

// モジュールスコープでプールを一度だけ生成する
// (Worker プロセス内で共有される)
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // 実運用推奨設定
  max:              10,   // 最大接続数
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});
```

**Step 3: UPSERT SQL を有効化する**

```typescript
export function createPersistRequestActivity(_config: Config, logger: Logger) {
  return async function persistRequestActivity(
    request: PlatformRequest,
    status: RequestStatus,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO platform_requests
         (id, tenant_id, user_id, action, resource, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (id)
       DO UPDATE SET status = $6, updated_at = NOW()`,
      [
        request.requestId,
        request.tenantId,
        request.userId,
        request.action,
        request.resource,
        status,
      ],
    );
  };
}
```

**Step 4: 環境変数を設定する**

```bash
export DATABASE_URL=postgresql://temporal:temporal@localhost:5432/temporal
```

#### DB スキーマ (再掲)

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

#### 注意事項

- `ON CONFLICT DO UPDATE` により、Temporal のリトライで同じリクエストが再実行されても安全です（冪等）。
- プールはモジュールスコープで一度だけ生成します。アクティビティ関数の中で毎回 `new pg.Pool()` しないでください。

---

### 7.4 Readiness チェックの追加 (`healthServer`)

**対象ファイル:** `src/product/index.ts`

#### 現在の構造

```typescript
const closeHealth = startHealthServer({
  checks: {
    opa: async () => { /* OPA /health */ },
  },
}, logger);
```

#### 拡張方法 — Temporal 接続確認

```typescript
import { Connection } from '@temporalio/client';

checks: {
  opa: async () => {
    const res = await fetch(`${config.opa.baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  },

  temporal: async () => {
    // gRPC 接続確認 — connect が失敗すれば false を返す
    try {
      const conn = await Connection.connect({ address: config.temporal.address });
      await conn.close();
      return true;
    } catch {
      return false;
    }
  },
},
```

#### 拡張方法 — PostgreSQL ping

```typescript
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

checks: {
  // ... 既存チェック ...

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

#### Readiness レスポンス例

```json
// 全チェック成功 → 200
{ "status": "ok", "checks": { "opa": true, "temporal": true, "postgres": true } }

// PostgreSQL 障害 → 503
{ "status": "degraded", "checks": { "opa": true, "temporal": true, "postgres": false } }
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
