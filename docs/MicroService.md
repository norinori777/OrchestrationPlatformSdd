# マイクロサービス 設計書

> 対象ディレクトリ: `src/MicroService/`  
> バージョン: 1.0  
> 作成日: 2026-04-30

---

## 1. 目的・スコープ

本ドキュメントは、オーケストレーションプラットフォームから呼び出される
**2 つのドメインマイクロサービス**の設計を定義します。

| サービス | 責務 |
|----------|------|
| `UserService` | テナントごとのユーザー情報の永続管理 (CRUD) |
| `FileStorageService` | テナントごとのファイルメタデータの永続管理 (CRUD) |

各サービスは独立した PostgreSQL スキーマを持ち、REST API を通じて操作されます。
SaaS Backend からのリクエストはオーケストレーション基盤 (`src/product/`) を経由して
各サービスへ到達します。

---

## 2. アーキテクチャ概要

```
┌────────────────────────────────────────────────────────────────┐
│  SaaS Backend (src/Saas/backend/)                              │
│  NATS platform.events.users / platform.events.files へ発行     │
└───────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────┐
│  オーケストレーション基盤 (src/product/)                        │
│  OPA 認可 → クォータ確認 → ドメインロジック → 通知 → 永続化      │
└──────────────┬─────────────────────────────┬───────────────────┘
               │ HTTP                        │ HTTP
               ▼                             ▼
┌─────────────────────────┐   ┌─────────────────────────────────┐
│  UserService            │   │  FileStorageService              │
│  PORT: 4002             │   │  PORT: 4001                      │
│  Express + Prisma       │   │  Express + Prisma                │
│  DB: service_users      │   │  DB: files                       │
└─────────────────────────┘   └─────────────────────────────────┘
```

---

## 3. ディレクトリ構成

```
src/MicroService/
├── UserService/
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma/
│   │   └── schema.prisma      ServiceUser モデル定義
│   └── src/
│       ├── index.ts           エントリーポイント
│       └── routes/
│           └── users.ts       ユーザー CRUD ルーター
└── FileStorageService/
    ├── package.json
    ├── tsconfig.json
    ├── prisma/
    │   └── schema.prisma      File モデル定義
    └── src/
        ├── index.ts           エントリーポイント
        └── routes/
            └── files.ts       ファイル CRUD ルーター
```

---

## 4. UserService

### 4.1 概要

| 項目 | 内容 |
|------|------|
| ポート | `PORT` 環境変数 (デフォルト: `4002`) |
| フレームワーク | Express + TypeScript |
| ORM | Prisma |
| データベース | PostgreSQL (`service_users` テーブル) |

### 4.2 API エンドポイント

| メソッド | パス | 説明 | レスポンス |
|----------|------|------|-----------|
| `GET` | `/health` | ヘルスチェック | `200 { status: 'ok', service: 'user-service' }` |
| `POST` | `/api/users` | ユーザー作成 | `201` 作成されたユーザー / `400` バリデーションエラー |
| `GET` | `/api/users/:id` | ユーザー取得 | `200` ユーザー / `404` Not Found |
| `DELETE` | `/api/users/:id` | ユーザー削除 | `204 No Content` / `403` テナント不一致 / `404` Not Found |

### 4.3 リクエスト仕様

#### POST `/api/users` ボディ

```typescript
{
  id:       string   // 必須 — ユーザー ID (外部で生成)
  tenantId: string   // 必須 — テナント識別子
  email:    string   // 必須 — メールアドレス (重複不可: tenantId + email)
  name:     string   // 必須 — 表示名
  role?:    'admin' | 'operator' | 'viewer'  // デフォルト: 'viewer'
}
```

#### DELETE `/api/users/:id` ヘッダー

| ヘッダー | 説明 |
|----------|------|
| `x-tenant-id` | テナント ID。設定された場合、レコードの `tenantId` と一致しなければ `403 Forbidden` |

### 4.4 バリデーション

[yup](https://github.com/jquense/yup) スキーマによるリクエストバリデーションを実施。
エラー時は `400 { error: string[] }` を返します。

---

## 5. FileStorageService

### 5.1 概要

| 項目 | 内容 |
|------|------|
| ポート | `PORT` 環境変数 (デフォルト: `4001`) |
| フレームワーク | Express + TypeScript |
| ORM | Prisma |
| データベース | PostgreSQL (`files` テーブル) |

### 5.2 API エンドポイント

| メソッド | パス | 説明 | レスポンス |
|----------|------|------|-----------|
| `GET` | `/health` | ヘルスチェック | `200 { status: 'ok', service: 'file-storage-service' }` |
| `POST` | `/api/files` | ファイルメタデータ作成 | `201` 作成されたファイル / `400` バリデーションエラー |
| `GET` | `/api/files/:id` | ファイルメタデータ取得 | `200` ファイル / `404` Not Found |
| `DELETE` | `/api/files/:id` | ファイルメタデータ削除 | `204 No Content` / `403` テナント不一致 / `404` Not Found |

### 5.3 リクエスト仕様

#### POST `/api/files` ボディ

```typescript
{
  id:           string   // 必須 — ファイル ID (外部で生成)
  tenantId:     string   // 必須 — テナント識別子
  userId:       string   // 必須 — アップロードユーザー ID
  filename:     string   // 必須 — ファイル名
  storagePath:  string   // 必須 — ストレージ上のパス
  size?:        number   // 任意 — ファイルサイズ (bytes)
  contentType?: string   // 任意 — MIME タイプ
}
```

#### DELETE `/api/files/:id` ヘッダー

| ヘッダー | 説明 |
|----------|------|
| `x-tenant-id` | テナント ID。設定された場合、レコードの `tenantId` と一致しなければ `403 Forbidden` |

### 5.4 バリデーション

[yup](https://github.com/jquense/yup) スキーマによるリクエストバリデーションを実施。
エラー時は `400 { error: string[] }` を返します。

---

## 6. データモデル

### 6.1 `ServiceUser` テーブル (`service_users`) — UserService

| カラム | 型 | 制約 | 説明 |
|--------|----|------|------|
| `id` | `String` | PK | ユーザー ID |
| `tenantId` | `String` | — | テナント識別子 |
| `email` | `String` | UNIQUE(tenantId, email) | メールアドレス |
| `name` | `String` | — | 表示名 |
| `role` | `String` | デフォルト: `'viewer'` | `admin` / `operator` / `viewer` |
| `createdAt` | `DateTime` | 自動 | 作成日時 |
| `updatedAt` | `DateTime` | 自動更新 | 更新日時 |

インデックス: `(tenantId)`

### 6.2 `File` テーブル (`files`) — FileStorageService

| カラム | 型 | 制約 | 説明 |
|--------|----|------|------|
| `id` | `String` | PK | ファイル ID |
| `tenantId` | `String` | — | テナント識別子 |
| `userId` | `String` | — | アップロードユーザー ID |
| `filename` | `String` | — | ファイル名 |
| `size` | `Int?` | NULL 可 | ファイルサイズ (bytes) |
| `contentType` | `String?` | NULL 可 | MIME タイプ |
| `storagePath` | `String` | — | ストレージ上のパス |
| `createdAt` | `DateTime` | 自動 | 作成日時 |
| `updatedAt` | `DateTime` | 自動更新 | 更新日時 |

インデックス: `(tenantId)`

---

## 7. テナント分離方針

各マイクロサービスはすべてのリクエストに `tenantId` を含め、
クエリ条件として使用することでデータ分離を実現します。

削除操作では `x-tenant-id` ヘッダーを検証し、
異なるテナントのリソースへの操作を `403 Forbidden` で拒否します。

---

## 8. 環境変数

### UserService

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `4002` | サーバーポート |
| `DATABASE_URL` | — | PostgreSQL 接続文字列 |

### FileStorageService

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `4001` | サーバーポート |
| `DATABASE_URL` | — | PostgreSQL 接続文字列 |

---

## 9. シーケンス図 — ユーザー作成フロー

```
オーケストレーション基盤   UserService        PostgreSQL
        │                     │                   │
        │ POST /api/users      │                   │
        │─────────────────────▶│                   │
        │                     │ INSERT service_users│
        │                     │───────────────────▶│
        │                     │                   │
        │ 201 {user}           │                   │
        │◀─────────────────────│                   │
```

---

## 10. シーケンス図 — ファイルメタデータ削除フロー

```
オーケストレーション基盤   FileStorageService     PostgreSQL
        │                       │                    │
        │ DELETE /api/files/:id  │                    │
        │ x-tenant-id: tenant-001│                    │
        │───────────────────────▶│                    │
        │                       │ SELECT files WHERE id│
        │                       │───────────────────▶│
        │                       │ tenantId 検証       │
        │                       │  OK → DELETE       │
        │                       │───────────────────▶│
        │ 204 No Content        │                    │
        │◀───────────────────────│                    │
```

---

## 11. 関連コンポーネント

| コンポーネント | 役割 |
|----------------|------|
| SaaS Backend (`src/Saas/backend/`) | ユーザー / ファイル操作リクエストを受け付け、NATS へ発行 |
| オーケストレーション基盤 (`src/product/`) | NATS イベントを消費し、OPA 認可後に各マイクロサービスを呼び出す |
