# SaaS アプリケーション 設計書

> 対象ディレクトリ: `src/Saas/`  
> バージョン: 1.0  
> 作成日: 2026-04-30

---

## 1. 目的・スコープ

本 SaaS アプリケーションは、マルチテナント対応のファイル管理・ユーザー管理機能を提供する
**イベント駆動型 Web アプリケーション**です。

主な責務:

- テナント別のファイルアップロード / 削除リクエストの受付
- テナント別のユーザー作成 / 削除リクエストの受付
- リクエストを PostgreSQL へ記録し、非同期で NATS JetStream へイベントを発行
- React + Vite による SPA フロントエンドの提供

---

## 2. アーキテクチャ概要

```
┌───────────────────────────────────────────────────────┐
│  ブラウザ (SPA)                                        │
│  React + Vite  (src/Saas/frontend/)                   │
│  ページ: /login  /files  /users                        │
└───────────────────────┬───────────────────────────────┘
                        │ HTTP (fetch)  /api/*
                        ▼
┌───────────────────────────────────────────────────────┐
│  SaaS Backend  (src/Saas/backend/)                    │
│  Express + TypeScript   PORT: 3001                    │
│  ├── POST/DELETE /api/files   → files ルーター        │
│  ├── POST/DELETE /api/users   → users ルーター        │
│  ├── GET /api/files/:id       → 状態照会              │
│  ├── GET /api/users/:id       → 状態照会              │
│  └── GET /health              → ヘルスチェック         │
└──────────┬───────────────────┬───────────────────────┘
           │ Prisma (ORM)      │ publishEvent()
           ▼                   ▼
    ┌─────────────┐     ┌─────────────────────────────┐
    │ PostgreSQL  │     │ NATS JetStream               │
    │ saas_requests│    │ subject: platform.events.*   │
    └─────────────┘     └─────────────────────────────┘
```

---

## 3. ディレクトリ構成

```
src/Saas/
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma/
│   │   └── schema.prisma       データモデル定義
│   └── src/
│       ├── index.ts            エントリーポイント / サーバー起動
│       ├── natsClient.ts       NATS 接続・発行ユーティリティ
│       └── routes/
│           ├── files.ts        ファイル操作ルーター
│           └── users.ts        ユーザー操作ルーター
└── frontend/
    ├── package.json
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx            React エントリーポイント
        ├── App.tsx             ルーティング定義
        ├── api/
        │   └── client.ts       バックエンド API クライアント
        └── pages/
            ├── LoginPage.tsx   テナント / ユーザー ID 入力
            ├── FilesPage.tsx   ファイル操作 UI
            └── UsersPage.tsx   ユーザー操作 UI
```

---

## 4. バックエンド詳細

### 4.1 エントリーポイント (`index.ts`)

| 項目 | 内容 |
|------|------|
| フレームワーク | Express |
| ポート | `PORT` 環境変数 (デフォルト: `3001`) |
| ミドルウェア | `cors()`, `express.json()` |
| 起動処理 | `connectNats()` → `app.listen()` |
| 終了処理 | `SIGTERM` / `SIGINT` で `drainNats()` を呼び出してグレースフルシャットダウン |

### 4.2 NATS クライアント (`natsClient.ts`)

| 関数 | 説明 |
|------|------|
| `connectNats()` | NATS サーバーへ接続。`NATS_URL` 環境変数を参照 (デフォルト: `nats://localhost:4222`) |
| `publishEvent(subject, data)` | JSON シリアライズしてサブジェクトへ発行 |
| `drainNats()` | 接続を安全にドレイン・切断 |

### 4.3 ファイルルーター (`routes/files.ts`)

| メソッド | パス | 説明 |
|----------|------|------|
| `POST` | `/api/files` | ファイル保管リクエスト作成。`saas_requests` へ `pending` で保存後、NATS `platform.events.files` へイベント発行。`202 Accepted` を返す |
| `GET` | `/api/files/:requestId` | リクエスト状態確認 |
| `DELETE` | `/api/files/:fileId` | ファイル削除リクエスト作成。NATS へ `action: delete` イベント発行 |

**POST ボディバリデーション (yup)**

```typescript
{
  tenantId:    string   // 必須
  userId:      string   // 必須
  filename:    string   // 必須
  storagePath: string   // 必須
  size?:       number   // 任意
  contentType?: string  // 任意
}
```

### 4.4 ユーザールーター (`routes/users.ts`)

| メソッド | パス | 説明 |
|----------|------|------|
| `POST` | `/api/users` | ユーザー作成リクエスト。NATS `platform.events.users` へイベント発行。`202 Accepted` を返す |
| `GET` | `/api/users/:requestId` | リクエスト状態確認 |
| `DELETE` | `/api/users/:targetUserId` | ユーザー削除リクエスト。NATS へ `action: delete` イベント発行 |

**POST ボディバリデーション (yup)**

```typescript
{
  tenantId: string                              // 必須
  userId:   string                              // 必須
  email:    string (email format)               // 必須
  name:     string                              // 必須
  role?:    'admin' | 'operator' | 'viewer'    // デフォルト: 'viewer'
}
```

---

## 5. データモデル

### 5.1 `SaasRequest` テーブル (`saas_requests`)

| カラム | 型 | 説明 |
|--------|----|------|
| `id` | `String` (PK) | リクエスト ID (`req-file-{uuid}` / `req-user-{uuid}`) |
| `tenantId` | `String` | テナント識別子 |
| `userId` | `String` | 操作実行ユーザー ID |
| `action` | `String` | `create` / `delete` |
| `resource` | `String` | `files` / `users` |
| `status` | `String` | `pending` → オーケストレーション後に更新 |
| `payload` | `Json?` | リクエスト詳細ペイロード |
| `result` | `String?` | 処理結果メッセージ |
| `createdAt` | `DateTime` | 作成日時 (自動) |
| `updatedAt` | `DateTime` | 更新日時 (自動) |

インデックス: `(tenantId, resource)`

---

## 6. NATS イベント仕様

### 6.1 ファイルイベント

**サブジェクト**: `platform.events.files`

```json
{
  "requestId": "req-file-{uuid}",
  "tenantId":  "tenant-001",
  "userId":    "user-001",
  "action":    "create",
  "resource":  "files",
  "payload": {
    "filename":    "report.pdf",
    "storagePath": "/uploads/tenant-001/report.pdf",
    "size":        1048576,
    "contentType": "application/pdf"
  }
}
```

### 6.2 ユーザーイベント

**サブジェクト**: `platform.events.users`

```json
{
  "requestId": "req-user-{uuid}",
  "tenantId":  "tenant-001",
  "userId":    "user-001",
  "action":    "create",
  "resource":  "users",
  "payload": {
    "email": "alice@example.com",
    "name":  "Alice",
    "role":  "operator"
  }
}
```

---

## 7. フロントエンド詳細

### 7.1 技術スタック

| 項目 | 技術 |
|------|------|
| ビルドツール | Vite |
| フレームワーク | React + TypeScript |
| ルーティング | React Router v6 |
| フォームバリデーション | react-hook-form + yup |
| API 通信 | Fetch API |

### 7.2 画面一覧

| パス | コンポーネント | 説明 |
|------|---------------|------|
| `/login` | `LoginPage` | `tenantId` と `userId` を `sessionStorage` へ保存 |
| `/files` | `FilesPage` | ファイルアップロード / 削除フォーム、リクエスト結果一覧表示 |
| `/users` | `UsersPage` | ユーザー作成 / 削除フォーム、リクエスト結果一覧表示 |
| `*` | - | `/files` へリダイレクト |

### 7.3 API クライアント (`api/client.ts`)

| 関数 | HTTP | 説明 |
|------|------|------|
| `uploadFile(data)` | `POST /api/files` | ファイル保管リクエスト発行 |
| `deleteFile(fileId, tenantId, userId)` | `DELETE /api/files/:id` | ファイル削除リクエスト発行 |
| `createUser(data)` | `POST /api/users` | ユーザー作成リクエスト発行 |
| `deleteUser(targetUserId, tenantId, userId)` | `DELETE /api/users/:id` | ユーザー削除リクエスト発行 |

### 7.4 認証・セッション管理

ログインページで入力した `tenantId` / `userId` を `sessionStorage` に保存し、
各ページでリクエストボディに付与して送信します。
サーバーサイドのセッション管理は行わず、バックエンドがリクエストの `tenantId` を信頼する簡易実装です。

---

## 8. 環境変数

### バックエンド

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `3001` | サーバーポート |
| `DATABASE_URL` | — | PostgreSQL 接続文字列 |
| `NATS_URL` | `nats://localhost:4222` | NATS サーバー URL |

---

## 9. シーケンス図 — ファイルアップロード

```
ブラウザ      SaaS Backend      PostgreSQL     NATS
  │                │                 │            │
  │ POST /api/files│                 │            │
  │───────────────▶│                 │            │
  │                │ INSERT pending  │            │
  │                │────────────────▶│            │
  │                │                 │            │
  │                │ publish event   │            │
  │                │─────────────────────────────▶│
  │                │                 │            │
  │ 202 {requestId}│                 │            │
  │◀───────────────│                 │            │
  │                │                 │            │
  │ (非同期)        │                 │     オーケストレーション基盤が処理
  │                │                 │            │
  │ GET /api/files/{requestId}        │            │
  │───────────────▶│                 │            │
  │                │ SELECT          │            │
  │                │────────────────▶│            │
  │ {status}       │                 │            │
  │◀───────────────│                 │            │
```

---

## 10. 関連コンポーネント

| コンポーネント | 役割 |
|----------------|------|
| オーケストレーション基盤 (`src/product/`) | NATS イベントを消費し、OPA 認可 → クォータ確認 → 永続化 → 通知を実行 |
| UserService (`src/MicroService/UserService/`) | ユーザーデータを実際に管理するマイクロサービス |
| FileStorageService (`src/MicroService/FileStorageService/`) | ファイルメタデータを実際に管理するマイクロサービス |
