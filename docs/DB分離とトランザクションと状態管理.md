# DB 分離・トランザクション・状態管理 整合性設計書

> 対象: オーケストレーションプラットフォーム全体  
> バージョン: 1.1  
> 作成日: 2026-05-01  
> 更新日: 2026-05-01 — Saga 補償アクティビティ実装に伴い §3.3 / §4.2 / §4.4 / §6 / §7 を更新

---

## 1. DB 分離構成

### 1.1 物理構成

PostgreSQL サーバーは 1 台。データベースは `appdb` に統一し、**スキーマで論理分離**する。

```
PostgreSQL (localhost:5432)
└── appdb
    ├── saas      → saas_requests          (SaaS Backend が所有)
    ├── platform  → platform_requests      (オーケストレーション基盤が所有)
    ├── users     → service_users          (UserService が所有)
    └── files     → files                  (FileStorageService が所有)
```

### 1.2 接続先と環境変数

| サービス | スキーマ | 環境変数 | デフォルト接続先 |
|---------|---------|---------|----------------|
| SaaS Backend | `saas` | `SAAS_DATABASE_URL` | `appdb?schema=saas` |
| Product (基盤) | `platform` | `PLATFORM_DATABASE_URL` | `appdb?schema=platform` |
| UserService | `users` | `USER_SERVICE_DATABASE_URL` | `appdb?schema=users` |
| FileStorageService | `files` | `FILE_SERVICE_DATABASE_URL` | `appdb?schema=files` |

### 1.3 分離の原則

- 各サービスは **自スキーマのテーブルのみ** を Prisma Client で操作する
- スキーマ間の SQL JOIN・直接参照は**禁止**
- スキーマ間の連携は **REST API / NATS イベント** のみで行う
- マイグレーション履歴 (`_prisma_migrations`) も各スキーマ内で独立管理する

---

## 2. テーブル設計と責務

### 2.1 `saas.saas_requests` — 受付台帳 (SaaS Backend 所有)

| カラム | 型 | 役割 |
|--------|----|------|
| `id` | String PK | requestId。クライアントへ返す追跡キー |
| `tenantId` | String | テナント識別子 |
| `userId` | String | 操作ユーザー |
| `action` | String | `create` / `delete` |
| `resource` | String | `files` / `users` |
| `status` | String | クライアント向け表示ステータス |
| `payload` | Json? | リクエスト詳細 |
| `result` | String? | 処理結果メッセージ |

**位置づけ:** クライアント (ブラウザ) が `GET /api/files/:requestId` で参照する「問い合わせ窓口」。正源ではない。

### 2.2 `platform.platform_requests` — 処理台帳 (Product 所有)

| カラム | 型 | 役割 |
|--------|----|------|
| `id` | String PK | requestId (saas_requests と共通) |
| `status` | String | **処理ステータスの正源** |
| `result` | String? | 処理結果メッセージ |
| その他 | — | tenantId / userId / action / resource / payload |

**位置づけ:** オーケストレーション基盤が管理する**唯一の真実 (Single Source of Truth)**。

### 2.3 業務データテーブル

| テーブル | スキーマ | 所有サービス | 内容 |
|---------|---------|------------|------|
| `service_users` | `users` | UserService | 実際のユーザー情報 |
| `files` | `files` | FileStorageService | 実際のファイルメタデータ |

---

## 3. トランザクション設計

### 3.1 なぜ分散トランザクションを使わないか

スキーマが論理分離されているため、技術的には同一 DB サーバー上の 2 フェーズコミット (2PC) は可能だが、以下の理由で採用しない。

1. **将来の物理分離に対応できない** — スキーマを別 DB サーバーへ移行した瞬間に 2PC が使えなくなる
2. **Temporal がより強い保証を提供する** — アクティビティの自動リトライ・冪等実行により、2PC と同等以上の信頼性を達成できる
3. **サービス境界の崩壊を防ぐ** — DB トランザクションで境界をまたぐと、スキーマ分離の意味がなくなる

### 3.2 スキーマ内トランザクション (許可)

各サービスは**自スキーマ内のみ**でローカルトランザクションを使用できる。

```typescript
// 例: UserService 内で複数操作が必要な場合
await prisma.$transaction(async (tx) => {
  await tx.serviceUser.create({ ... });
  await tx.someOtherTable.update({ ... });
});
```

### 3.3 スキーマ間の整合性 (Temporal + ベストエフォートコールバック)

スキーマをまたぐ操作は、以下の 2 層で整合性を担保する。

**第 1 層: Temporal ワークフローによる Saga パターン**

```
platformWorkflow
  ├── persistRequestActivity(pending)          ← platform_requests に記録
  ├── evaluatePolicyActivity                   ← OPA (外部)
  │     └─ 拒否 → persistRequestActivity(denied) → 終了
  ├── checkQuotaActivity                       ← Redis (外部)
  │     └─ 超過 → persistRequestActivity(denied) → 終了
  ├── [try]
  │   ├── processRequestActivity               ← UserService / FileStorageService へ HTTP (業務副作用)
  │   ├── sendNotificationActivity             ← 成功通知
  │   └── persistRequestActivity(completed)   ← platform_requests 更新 + SaaS コールバック
  └── [catch] 業務副作用発生後の失敗
        ├── compensateRequestActivity          ← 作成済みリソースを DELETE で取り消し (create 系のみ)
        └── persistRequestActivity(failed)    ← platform_requests 更新 + SaaS コールバック
```

各ステップは Temporal のアクティビティとして実行され、失敗時は自動リトライされる。  
`compensateRequestActivity` 自体も Temporal のリトライポリシーが適用されるため、補償操作の冪等性は 404 無視で担保する。

**第 2 層: ベストエフォートコールバック**

`platform_requests` 更新成功後、SaaS Backend の `PATCH /api/requests/:id/status` を呼び出して `saas_requests` を同期する。このコールバックは**ワークフローを止めない** (失敗してもログに記録するだけ)。

```typescript
// persistenceActivity.ts の実装
// ① platform_requests upsert (必ず成功させる)
await prisma.platformRequest.upsert({ ... });

// ② saas_requests 同期 (ベストエフォート)
try {
  await fetch(`${config.saasBackendUrl}/api/requests/${requestId}/status`, {
    method: 'PATCH',
    body:   JSON.stringify({ status, result }),
  });
} catch {
  logger.warn('callback failed (ignored)');
}
```

---

## 4. 状態管理

### 4.1 状態の正源

```
正源: platform.platform_requests.status
         ↓ コールバック同期 (ベストエフォート)
表示用: saas.saas_requests.status  ← クライアントが参照
```

### 4.2 ステータス遷移

```
                     NATS イベント受信
                          │
                          ▼
              ┌─────── pending ────────┐
              │  (platform / saas 両方)│
              └───────────┬────────────┘
                          │
          ┌───────────────┼───────────────────────┐
          │               │                       │
          ▼               ▼                       │
       denied          denied                     │
    (OPA 拒否)     (クォータ超過)                 │
                                                  │ processRequestActivity 成功
                          ┌───────────────────────┤
                          │                       │
                          ▼                       ▼
                        failed                completed
                  (例外 → Saga 補償済)      (業務処理成功)
                  (キャンセル)
```

**failed への遷移詳細 (create 系):**
```
processRequestActivity 失敗 (例外)
  → compensateRequestActivity  (作成済みリソースを DELETE)
  → persistRequestActivity(failed)
```

| ステータス | 設定タイミング | 設定場所 |
|-----------|-------------|---------|
| `pending` | NATS イベント受信直後 / Temporal 開始直後 | SaaS Backend + platform Activity |
| `denied` | OPA 拒否 / クォータ超過 | platform Activity → SaaS コールバック |
| `completed` | 業務処理成功 | platform Activity → SaaS コールバック |
| `failed` | キャンセル / 予期しないエラー | platform Activity → SaaS コールバック |

### 4.3 クライアントから見た状態確認フロー

```
ブラウザ          SaaS Backend              Platform              DB
   │                   │                       │                   │
   │ POST /api/files   │                       │                   │
   │──────────────────▶│                       │                   │
   │                   │─── INSERT pending ────────────────────────▶ saas.saas_requests
   │                   │─── publishEvent ──────▶ NATS              │
   │ 202 {requestId}   │                       │                   │
   │◀──────────────────│                       │                   │
   │                   │                       │                   │
   │                   │      NATS ────────────▶ platformWorkflow  │
   │                   │                       │── upsert pending ─▶ platform.platform_requests
   │                   │                       │── OPA / Quota / 業務処理
   │                   │                       │── upsert completed▶ platform.platform_requests
   │                   │◀── PATCH /api/requests/:id/status ────────│
   │                   │─── UPDATE completed ──────────────────────▶ saas.saas_requests
   │                   │                       │                   │
   │ GET /api/files/:id│                       │                   │
   │──────────────────▶│                       │                   │
   │                   │─── SELECT ────────────────────────────────▶ saas.saas_requests
   │ {status:completed}│                       │                   │
   │◀──────────────────│                       │                   │
```

### 4.4 Temporal Query による中間状態の確認

Temporal ワークフローが実行中の場合、`getStatus` Query で処理の現在ステップを直接取得できる。

```typescript
// ワークフロー内で currentStatus を都度更新
currentStatus = 'evaluating-policy';
currentStatus = 'checking-quota';
currentStatus = 'processing';
currentStatus = 'notifying';
currentStatus = 'completed';
```

| `getStatus` の値 | 意味 |
|----------------|------|
| `started` | ワークフロー開始直後 |
| `persisting` | DB 保存中 |
| `evaluating-policy` | OPA ポリシー評価中 |
| `checking-quota` | Redis クォータ確認中 |
| `processing` | 業務処理 (HTTP 呼び出し) 中 |
| `notifying` | 通知送信中 |
| `completed` | 完了 |
| `compensating` | Saga 補償中 (create 失敗後に業務データを取り消し中) |
| `failed` | 補償完了後の終端ステータス |

---

## 5. 冪等性設計

### 5.1 `platform_requests` — upsert による冪等性

```typescript
await prisma.platformRequest.upsert({
  where:  { id: request.requestId },  // requestId が一致すれば UPDATE
  create: { ... },
  update: { status, result },         // 同じ requestId を何度受け取っても安全
});
```

### 5.2 NATS ワークフロー起動 — workflowId による重複排除

```typescript
// gateway.ts
await client.start(platformWorkflow, {
  workflowId: `platform-${request.requestId}`,  // 同じ ID は 1 回だけ実行
  ...
});
```

同じ `requestId` のワークフローが既に存在する場合、Temporal は新規起動をスキップする。

### 5.3 マイクロサービス書き込み — PK による重複排除

```typescript
// FileStorageService / UserService
await prisma.file.create({ data: { id: req.requestId, ... } });
// id が PK のため、同じ id で再実行すると Unique 制約エラー → Temporal がリトライせず終了
```

---

## 6. 障害シナリオと対応

| シナリオ | 影響 | 対応 |
|---------|------|------|
| NATS → Platform 配送失敗 | Temporal 未起動 | JetStream が `max_deliver: 3` 回再配送。3 回失敗で DLQ へ転送 |
| Temporal Activity 失敗 | 処理途中で停止 | 最大 3 回自動リトライ (指数バックオフ)。全失敗でワークフローが `failed` |
| platform_requests upsert 失敗 | platform に記録なし | Activity リトライで再実行。upsert なので重複なし |
| SaaS コールバック失敗 | saas_requests が `pending` のまま | ベストエフォート。platform_requests が正源なので整合性は保たれる。saas 側は最終的整合性 |
| UserService / FileStorageService 障害 (create) | 業務データが部分的に作成済みの状態で停止 | Temporal がリトライ。リトライ上限後は `compensateRequestActivity` で作成済みリソースを DELETE (Saga 補償)。その後 `failed` を永続化。補償操作は 404 を成功扱いにするため冪等 |
| UserService / FileStorageService 障害 (read/delete) | 補償操作なし | Temporal がリトライ。リトライ上限後は `failed` を永続化。read/delete は副作用なし、またはスナップショット未実装のため補償なし |
| platform_requests と saas_requests の乖離 | saas 側ステータスが古い | platform_requests を正源として修復スクリプトで同期可能 |

---

## 7. まとめ

| 課題 | 対応方針 |
|------|---------|
| スキーマ間のトランザクション不可 | Temporal ワークフローによる Saga パターンで補償 |
| 状態の二重管理 | `platform_requests` を正源に一本化し、SaaS へはコールバックで同期 |
| イベント再送・リトライ時の重複 | requestId を PK / workflowId に使い upsert / Temporal 重複排除で冪等化 |
| 業務処理の部分失敗 (create 系) | `compensateRequestActivity` で作成済みリソースを取り消し (Saga 補償)。その後 `failed` を永続化 |
| 業務処理の部分失敗 (read/delete 系) | Temporal の自動リトライで最終整合性を実現。補償なし |
| サービス境界の崩壊 | スキーマ間 SQL 禁止・API/イベント経由のみでデータ連携 |
