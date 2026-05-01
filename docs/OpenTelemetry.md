# OpenTelemetry 分散トレーシング 設計書

## 1. 概要

オーケストレーションプラットフォームに OpenTelemetry (OTel) SDK v2.x を導入し、  
**NATS メッセージ受信 → Temporal ワークフロー → 各アクティビティ** の全経路を  
1 本のトレースとして可視化できるようにした。  
バックエンドには **Jaeger all-in-one** を使用し、ローカル開発環境で即座に UI 確認ができる。

---

## 2. 採用技術

| ライブラリ | バージョン | 役割 |
|---|---|---|
| `@opentelemetry/api` | ^1.9 | Tracer API (計装コード側) |
| `@opentelemetry/sdk-trace-node` | ^2.x | NodeTracerProvider / BatchSpanProcessor |
| `@opentelemetry/exporter-trace-otlp-http` | ^0.57 | OTLP/HTTP エクスポーター (Jaeger 送信) |
| `@opentelemetry/resources` | ^2.x | リソース属性 (`resourceFromAttributes` / `defaultResource`) |
| `@opentelemetry/semantic-conventions` | ^1.28 | セマンティック属性キー定数 |
| `jaegertracing/all-in-one:1.57` | — | トレースバックエンド + UI |

---

## 3. アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│ platform プロセス (Node.js)                                      │
│                                                                 │
│  index.ts                                                       │
│   └─ initTelemetry()  ─────── NodeTracerProvider               │
│                                └─ BatchSpanProcessor            │
│                                    └─ OTLPTraceExporter          │
│                                        │  HTTP POST /v1/traces  │
└────────────────────────────────────────┼────────────────────────┘
                                         ▼
                               ┌──────────────────┐
                               │  Jaeger           │
                               │  :4318 (OTLP)    │
                               │  :16686 (UI)     │
                               └──────────────────┘
```

---

## 4. ファイル構成

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `src/product/telemetry.ts` | **新規** | SDK 初期化・トレーサー取得・終了処理 |
| `src/product/config.ts` | 変更 | `OtelConfig` インターフェース追加、環境変数ロード追加 |
| `src/product/index.ts` | 変更 | 起動時 `initTelemetry()` / 終了時 `shutdownTelemetry()` 呼び出し |
| `src/product/gateway.ts` | 変更 | `nats.message.process` スパン追加 |
| `src/product/activities/opaActivity.ts` | 変更 | `opa.evaluate_policy` スパン追加 |
| `src/product/activities/persistenceActivity.ts` | 変更 | `db.persist_request` / `http.saas_callback` スパン追加 |
| `src/product/activities/index.ts` | 変更 | `process.<key>` / `compensate.<key>` スパン追加 |
| `docker-compose.yaml` | 変更 | Jaeger サービス追加 |

---

## 5. `telemetry.ts` — SDK 初期化モジュール

### 設計方針

- `NodeTracerProvider` を **グローバルに 1 回だけ登録** する。
- `config.otel.enabled = false` のとき `initTelemetry()` は何もしない。  
  OTel API は未登録時に **NoOp Tracer** を返すため、計装コードは変更不要。
- `shutdownTelemetry()` を graceful shutdown フックに組み込み、バッファ内スパンをフラッシュしてからプロセスを終了する。

### 主要関数

```typescript
// 起動時に 1 回だけ呼ぶ
export function initTelemetry(config: OtelConfig): void

// 各モジュールで Tracer を取得する
export function getTracer(name: string): Tracer

// SIGTERM / SIGINT 時に呼ぶ
export async function shutdownTelemetry(): Promise<void>
```

### SDK v2.x 対応

OTel SDK v2.x では以下の API が変更された。旧 API は削除済みのため注意。

| 旧 API (v1.x) | 新 API (v2.x) |
|---|---|
| `new Resource({...})` | `resourceFromAttributes({...})` |
| `Resource.default()` | `defaultResource()` |
| `provider.addSpanProcessor(p)` | コンストラクタ引数 `{ spanProcessors: [p] }` |

---

## 6. OtelConfig — 設定インターフェース

```typescript
export interface OtelConfig {
  enabled:        boolean;  // OTEL_ENABLED (default: true)
  otlpEndpoint:   string;   // OTEL_EXPORTER_OTLP_ENDPOINT (default: http://localhost:4318/v1/traces)
  serviceName:    string;   // SERVICE_NAME (default: orchestration-platform)
  serviceVersion: string;   // SERVICE_VERSION (default: 1.0.0)
  environment:    string;   // DEPLOY_ENV (default: development)
}
```

### 環境変数一覧

| 環境変数 | デフォルト値 | 説明 |
|---|---|---|
| `OTEL_ENABLED` | `true` | `false` で OTel を無効化 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | Jaeger / Tempo の OTLP/HTTP エンドポイント |
| `SERVICE_NAME` | `orchestration-platform` | `service.name` リソース属性 |
| `SERVICE_VERSION` | `1.0.0` | `service.version` リソース属性 |
| `DEPLOY_ENV` | `development` | `deployment.environment` リソース属性 |

---

## 7. スパン計装詳細

### 7.1 `platform.gateway` — `nats.message.process`

**ファイル**: `src/product/gateway.ts`  
**スコープ**: NATS メッセージ 1 件の処理全体

| 属性名 | 値 | 説明 |
|---|---|---|
| `messaging.system` | `"nats"` | メッセージングシステム識別 |
| `messaging.destination` | `msg.subject` | JetStream サブジェクト |
| `messaging.message.sequence` | `msg.seq` | JetStream シーケンス番号 |
| `platform.request_id` | `request.requestId` | リクエスト ID |
| `platform.tenant_id` | `request.tenantId` | テナント ID |
| `platform.action` | `request.action` | 操作種別 |
| `platform.resource` | `request.resource` | リソース種別 |
| `temporal.workflow_id` | `"platform-{requestId}"` | 起動したワークフロー ID (成功時のみ) |
| `gateway.duplicate` | `true` | 重複ワークフロー ID 検出時のみ付与 |

### 7.2 `platform.opa` — `opa.evaluate_policy`

**ファイル**: `src/product/activities/opaActivity.ts`  
**スコープ**: OPA REST API 呼び出し全体 (リトライ含む)

| 属性名 | 値 | 説明 |
|---|---|---|
| `platform.tenant_id` | `input.tenantId` | テナント ID |
| `platform.user_id` | `input.userId` | ユーザー ID |
| `platform.action` | `input.action` | 評価する操作 |
| `platform.resource` | `input.resource` | 評価するリソース |
| `rpc.system` | `"opa"` | RPC システム識別 |
| `server.address` | `config.opa.baseUrl` | OPA サーバー URL |
| `opa.policy_path` | `config.opa.policyPath` | ポリシーパス |
| `opa.result` | `"allow"` \| `"deny"` | 評価結果 (成功時) |
| `opa.attempt_count` | 数値 | 実際の試行回数 |

エラー時は `span.recordException()` + `SpanStatusCode.ERROR` を設定してスローする。

### 7.3 `platform.persistence` — `db.persist_request` / `http.saas_callback`

**ファイル**: `src/product/activities/persistenceActivity.ts`

#### `db.persist_request`

| 属性名 | 値 |
|---|---|
| `db.system` | `"postgresql"` |
| `db.operation` | `"upsert"` |
| `db.sql.table` | `"platform_requests"` |
| `platform.request_id` | `request.requestId` |
| `platform.tenant_id` | `request.tenantId` |
| `platform.status` | upsert 後のステータス |

#### `http.saas_callback`

| 属性名 | 値 |
|---|---|
| `http.method` | `"PATCH"` |
| `http.url` | `{saasBackendUrl}/api/requests/{requestId}/status` |
| `platform.request_id` | `request.requestId` |
| `platform.status` | コールバックで通知するステータス |
| `http.response.status_code` | HTTP レスポンスコード |

> コールバック失敗はワークフローを止めない (ベストエフォート)。  
> 失敗時は `SpanStatusCode.ERROR` を記録するが例外はスローしない。

### 7.4 `platform.process` / `platform.compensate` — マイクロサービス呼び出し

**ファイル**: `src/product/activities/index.ts`

スパン名は `process.<action>:<resource>` / `compensate.<action>:<resource>` の形式。

| 属性名 | 値 |
|---|---|
| `platform.request_id` | `request.requestId` |
| `platform.action` | `request.action` |
| `platform.resource` | `request.resource` |
| `http.request.method` | `"POST"` / `"DELETE"` |

---

## 8. トレースの全体構造

1 リクエスト処理時に生成されるスパン階層:

```
nats.message.process                   (platform.gateway)
  │
  └─ [Temporal Worker 内]
       ├─ db.persist_request            (pending)
       │    └─ http.saas_callback
       │
       ├─ opa.evaluate_policy
       │
       ├─ db.persist_request            (denied — denied 時のみ)
       │    └─ http.saas_callback
       │
       ├─ process.<action>:<resource>   (allowed 時)
       │    └─ compensate.<action>:<resource>  (create 失敗時の Saga 補償)
       │
       └─ db.persist_request            (completed / failed)
            └─ http.saas_callback
```

---

## 9. インフラ構成 — Jaeger

`docker-compose.yaml` に追加したサービス:

```yaml
jaeger:
  image: jaegertracing/all-in-one:1.57
  container_name: jaeger
  environment:
    - COLLECTOR_OTLP_ENABLED=true
  networks:
    - saas-platform
  ports:
    - "16686:16686"  # Jaeger UI
    - "4317:4317"    # OTLP gRPC
    - "4318:4318"    # OTLP HTTP
```

| ポート | プロトコル | 用途 |
|---|---|---|
| 16686 | HTTP | Jaeger Web UI (`http://localhost:16686`) |
| 4318 | OTLP/HTTP | platform → Jaeger トレース送信 |
| 4317 | OTLP/gRPC | (将来拡張用) |

---

## 10. 起動・確認手順

### Jaeger 起動

```bash
docker compose up jaeger -d
```

### platform 起動 (OTel 有効)

```bash
# デフォルト設定のまま起動すると OTEL_ENABLED=true で Jaeger に送信
npx ts-node src/product/index.ts
```

### OTel を無効化する場合

```bash
OTEL_ENABLED=false npx ts-node src/product/index.ts
```

### トレース確認

1. `http://localhost:16686` をブラウザで開く  
2. Service = `orchestration-platform` を選択  
3. **Find Traces** → スパン一覧・ウォーターフォール表示で確認

---

## 11. テスト

OTel SDK は `OTEL_ENABLED=false` 相当 (NoOp Tracer) として動作するため、  
単体テスト / ワークフローテストの既存 27 件は変更なく全件 pass。

```
Test Files  4 passed (4)
     Tests  27 passed (27)
```

テスト実行:

```bash
npx vitest run
```

---

## 12. 今後の拡張ポイント

| 項目 | 内容 |
|---|---|
| メトリクス計装 | `@opentelemetry/sdk-metrics` を追加して OTLP でメトリクスも送信 |
| コンテキスト伝播 | NATS メッセージヘッダーに `traceparent` を付与して外部サービスとトレースを結合 |
| Grafana Tempo 移行 | `OTEL_EXPORTER_OTLP_ENDPOINT` を Tempo エンドポイントに変更するだけで切り替え可能 |
| サンプリング設定 | `NodeTracerProvider` に `sampler` を追加してヘッドサンプリングを制御 |
| ログ-トレース相関 | ログ出力時に `trace.getActiveSpan()` から `traceId`/`spanId` を取得してフィールドに付与 |
