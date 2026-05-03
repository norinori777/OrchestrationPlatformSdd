# RoutingFile サービス 設計書

## 概要

ファイルの内容を OpenAI API で解析し、文書カテゴリを判定して結果を保存する同期型 REST マイクロサービス。  
案1（同期 API）として実装された Phase 1 相当の実装。

---

## アーキテクチャ

```
HTTP クライアント
      │
      ▼
┌─────────────────────────────────┐
│  RoutingFile Service (Port 4003) │
│                                  │
│  routes/files.ts                 │
│    └─ POST /api/routing/classify │
│    └─ GET  /api/routing/:id      │
│                                  │
│  services/routing.ts             │
│    ├─ fileReader.ts              │
│    │    └─ ファイル読込 & 分割   │
│    ├─ classifier.ts              │
│    │    └─ OpenAI API 呼び出し   │
│    └─ Prisma (PostgreSQL)        │
└─────────────────────────────────┘
```

---

## ディレクトリ構成

```
src/MicroService/RoutingFile/
├── .env.example
├── package.json
├── tsconfig.json
├── prisma/
│   └── schema.prisma
├── docs/
│   ├── consideration.md   ← 検討資料
│   └── design.md          ← 本設計書
└── src/
    ├── index.ts
    ├── db.ts
    ├── types/
    │   └── routing.ts
    ├── services/
    │   ├── fileReader.ts
    │   ├── classifier.ts
    │   └── routing.ts
    └── routes/
        └── files.ts
```

---

## モジュール設計

### `src/index.ts` — エントリポイント

| 項目 | 内容 |
|------|------|
| ポート | `PORT` 環境変数（デフォルト: `4003`） |
| ミドルウェア | CORS、`express.json()` |
| ルーティング | `/api/routing` → `routes/files.ts` |
| ヘルスチェック | `GET /health` |
| 終了処理 | `SIGTERM` / `SIGINT` でサーバー停止 → `prisma.$disconnect()` |

---

### `src/db.ts` — データベース接続

```typescript
export const prisma = new PrismaClient();
```

PrismaClient のシングルトンインスタンス。全サービスレイヤーがこれをインポートして使う。

---

### `src/types/routing.ts` — 型定義

| 型 | 説明 |
|----|------|
| `FileCategory` | `invoice \| contract \| report \| email \| form \| other` |
| `RequestStatus` | `pending \| processing \| completed \| failed` |
| `ClassifyRequest` | API リクエスト本体の型 |
| `ChunkResult` | 1チャンク分の分類結果 |
| `ClassificationResult` | 全チャンク集約後の結果 |
| `ClassifyResponse` | API レスポンスの型 |

---

### `src/services/fileReader.ts` — ファイル読み込み & チャンク分割

#### 対応拡張子（Phase 1）

`.txt` / `.md` / `.csv` / `.json` / `.log`

#### チャンク分割ロジック

| パラメータ | デフォルト値 | 環境変数 |
|-----------|------------|---------|
| チャンク上限トークン数 | 2,000 | `MAX_CHUNK_TOKENS` |
| オーバーラップ | 100 トークン | — |
| トークン換算係数 | 3.5 文字/トークン | — |

- ファイル全体が上限以下の場合はチャンク分割なし（1 チャンクとして返す）
- 上限を超える場合はスライディングウィンドウで分割
- オーバーラップにより文脈の切断を軽減する

#### 公開関数

```typescript
validateExtension(filePath: string): void
readFileContent(filePath: string): string
splitIntoChunks(content: string): FileChunk[]
readAndChunk(filePath: string): FileChunk[]   // 上記3つをまとめたもの
```

---

### `src/services/classifier.ts` — OpenAI 分類

#### モデル設定

| 項目 | デフォルト | 環境変数 |
|------|----------|---------|
| モデル | `gpt-4o-mini` | `OPENAI_MODEL` |
| temperature | `0`（固定） | — |
| 1チャンク最大文字数 | 6,000 文字（安全上限） | — |
| プロンプトバージョン | `1.0.0` | — |

#### システムプロンプト

固定のシステムプロンプトを使い、応答を `response_format: json_object` で強制する。  
返却 JSON の形式:

```json
{
  "category": "invoice",
  "confidence": 0.92,
  "reason": "請求書番号と金額が含まれるため"
}
```

#### チャンク集約ロジック（`aggregateChunkResults`）

1. カテゴリごとに confidence の合計でスコアリング
2. 最高スコアのカテゴリを最終カテゴリとして採用
3. そのカテゴリのチャンク全体の平均 confidence を最終 confidence とする
4. 最初にマッチしたチャンクの `reason` を採用

#### 公開関数

```typescript
classifyChunk(chunkContent: string, chunkIndex: number): Promise<ChunkResult>
aggregateChunkResults(results: ChunkResult[]): { category, confidence, reason, model, promptVersion }
```

---

### `src/services/routing.ts` — オーケストレーション

#### `classifyFile` 処理フロー

```
1. UUID 生成 (uuid v4)
2. DB に status=processing で RoutingRequest を INSERT
3. fileReader.readAndChunk() でチャンク取得
4. MAX_CHUNKS_PER_FILE (デフォルト10) でチャンク数を制限
5. Promise.all() で全チャンクを並列分類
6. aggregateChunkResults() で最終カテゴリを決定
7. DB を status=completed に UPDATE
8. ClassifyResponse を返却
   ※ 例外発生時は status=failed / errorMessage を記録してから再スロー
```

| パラメータ | デフォルト | 環境変数 |
|-----------|----------|---------|
| 最大チャンク数 | 10 | `MAX_CHUNKS_PER_FILE` |

---

### `src/routes/files.ts` — HTTPルート定義

#### `POST /api/routing/classify`

**リクエスト本体（yup バリデーション）**

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| `filePath` | string | ✓ | サーバー上のファイルの絶対パス |
| `originalName` | string | ✓ | 元ファイル名（表示用） |
| `mimeType` | string | ✓ | MIME タイプ |
| `size` | number | — | ファイルサイズ (bytes) |

**レスポンス**

| HTTP | 条件 |
|------|------|
| 200 | 分類成功 |
| 400 | バリデーションエラー |
| 422 | 非対応ファイル種別 / ファイルが見つからない |
| 500 | 内部エラー |

**レスポンス本体（200）**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "filePath": "/data/invoice-001.txt",
  "mimeType": "text/plain",
  "status": "completed",
  "category": "invoice",
  "confidence": 0.92,
  "reason": "請求書番号と金額が含まれるため",
  "classifiedAt": "2026-05-02T10:00:00.000Z"
}
```

---

#### `GET /api/routing/:id`

保存済み分類結果を ID で取得する。

| HTTP | 条件 |
|------|------|
| 200 | 正常取得 |
| 404 | 対象レコードなし |
| 500 | 内部エラー |

---

## データベース設計

### テーブル: `routing_requests`

| カラム | 型 | NOT NULL | デフォルト | 説明 |
|--------|---|----------|-----------|------|
| `id` | TEXT (PK) | ✓ | uuid v4 | リクエスト識別子 |
| `filePath` | TEXT | ✓ | — | ファイルパス |
| `originalName` | TEXT | ✓ | — | 元ファイル名 |
| `mimeType` | TEXT | ✓ | — | MIME タイプ |
| `size` | INT | — | — | ファイルサイズ |
| `status` | TEXT | ✓ | `pending` | 処理ステータス |
| `category` | TEXT | — | — | 分類カテゴリ |
| `confidence` | FLOAT | — | — | 信頼度 (0.0〜1.0) |
| `reason` | TEXT | — | — | 分類理由（日本語） |
| `model` | TEXT | — | — | 使用 OpenAI モデル名 |
| `promptVersion` | TEXT | — | — | プロンプトバージョン |
| `errorMessage` | TEXT | — | — | エラーメッセージ |
| `chunkResults` | JSON | — | — | 全チャンクの分類結果配列 |
| `createdAt` | TIMESTAMP | ✓ | `now()` | 作成日時 |
| `updatedAt` | TIMESTAMP | ✓ | auto | 更新日時 |

**インデックス**

- `status`
- `category`

---

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|----------|------|
| `ROUTING_DATABASE_URL` | ✓ | — | PostgreSQL 接続文字列 |
| `OPENAI_API_KEY` | ✓ | — | OpenAI API キー |
| `OPENAI_MODEL` | — | `gpt-4o-mini` | 使用モデル |
| `PORT` | — | `4003` | リスンポート |
| `MAX_CHUNK_TOKENS` | — | `2000` | チャンクあたりのトークン上限 |
| `MAX_CHUNKS_PER_FILE` | — | `10` | ファイルあたりのチャンク上限 |

---

## 依存パッケージ

### 本番依存

| パッケージ | バージョン | 用途 |
|-----------|-----------|------|
| `express` | ^4.19.2 | HTTP サーバー |
| `cors` | ^2.8.5 | CORS 対応 |
| `@prisma/client` | ^5.14.0 | ORM クライアント |
| `openai` | ^4.52.0 | OpenAI SDK |
| `uuid` | ^10.0.0 | UUID 生成 |
| `yup` | ^1.4.0 | リクエストバリデーション |

### 開発依存

| パッケージ | 用途 |
|-----------|------|
| `typescript` | TypeScript コンパイラ |
| `ts-node-dev` | 開発時のホットリロード |
| `prisma` | マイグレーション CLI |
| 各種 `@types/*` | 型定義 |

---

## セットアップ手順

```bash
# 1. 依存パッケージインストール
cd src/MicroService/RoutingFile
npm install

# 2. 環境変数設定
cp .env.example .env
# .env を編集して ROUTING_DATABASE_URL と OPENAI_API_KEY を設定

# 3. Prisma マイグレーション
npx prisma migrate dev --name init

# 4. 起動（開発）
npm run dev

# 4. 起動（本番）
npm start
```

---

## 制約・注意事項

| 項目 | 内容 |
|------|------|
| 対応ファイル形式 | `.txt` / `.md` / `.csv` / `.json` / `.log` のみ (Phase 1) |
| ファイルアクセス方式 | サーバーファイルシステム上の絶対パスで直接読み込む |
| 同期処理 | 分類完了まで HTTP レスポンスを保留するため、大きいファイルはタイムアウトの恐れあり |
| 並列チャンク処理 | `Promise.all` により全チャンクを同時に OpenAI へ送信する |
| LLM コスト | `MAX_CHUNKS_PER_FILE` でチャンク数を制限して API コストを抑制 |
| OCR | 未対応（Phase 3 以降で追加予定） |

---

## 将来の拡張方針

| フェーズ | 内容 |
|---------|------|
| Phase 2 | PDF / docx / xlsx 対応（テキスト抽出モジュール追加） |
| Phase 3 | 画像・スキャン文書対応（ローカル OCR: tesseract） |
| 案2移行 | 非同期ジョブキュー方式（NATS + ワーカー）への移行 |
| キャッシュ | 同一ファイルの再分類結果をキャッシュ（Redis） |
