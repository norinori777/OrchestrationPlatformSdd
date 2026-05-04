// ─────────────────────────────────────────────────────────────────────────────
// 共有型定義 — ワークフロー・アクティビティ・ゲートウェイで使用
// ─────────────────────────────────────────────────────────────────────────────

/** プラットフォームへ送信されるリクエスト */
export interface PlatformRequest {
  /** グローバルにユニークなリクエスト ID (Temporal workflow ID に使用) */
  requestId: string;
  /** テナント ID */
  tenantId: string;
  /** リクエストを発行したユーザー ID */
  userId: string;
  /** 実行アクション (例: "create", "read", "delete") */
  action: string;
  /** 対象リソース (例: "orders", "users", "reports") */
  resource: string;
  /** アクション固有の追加ペイロード */
  payload: Record<string, unknown>;
}

/** リクエスト処理の最終結果 */
export interface PlatformResponse {
  requestId: string;
  status: 'allowed' | 'denied' | 'quota-exceeded' | 'error';
  message: string;
  processedAt: string;
}

/** OPA ポリシー評価の入力 */
export interface PolicyInput {
    tenantId: string;
    userId:   string;
    action:   string;
    resource: string;
}

/** 通知アクティビティへのペイロード */
export interface NotificationPayload {
  tenantId:  string;
  userId:    string;
  requestId: string;
  status:    PlatformResponse['status'];
  message:   string;
}

/** リクエストの処理ステータス */
export type RequestStatus = 'pending' | 'denied' | 'completed' | 'failed';

/** Redis クォータチェックの結果 */
export interface QuotaResult {
  /** クォータ上限内かどうか */
  allowed: boolean;
  /** 現在のウィンドウ内リクエスト数 */
  current: number;
  /** 設定されたクォータ上限 */
  limit: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 定義駆動オーケストレーション — 複数マイクロサービス連携用の型定義
// PlatformRequest.payload.orchestration に OrchestrationDefinition を埋め込むと
// platformWorkflow が steps を順番に実行し、失敗時は逆順に補償する。
// ─────────────────────────────────────────────────────────────────────────────

/** orchestration step 内の補償 (Saga 巻き戻し) 定義 */
export interface StepCompensation {
  /** 補償呼び出し先サービス名 */
  service: string;
  method:  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** パスは "{result.id}" 等のテンプレートで step の実行結果を参照できる */
  path:    string;
  headers?: Record<string, string>;
  query?:   Record<string, string>;
  body?:    Record<string, unknown>;
}

/** orchestration の 1 ステップ定義 */
export interface OrchestrationStep {
  /** 呼び出し先サービス名 (SERVICE_REGISTRY のキー) */
  service: string;
  method:  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * 呼び出し先パス。
   * "{step0.body.id}" のように前段ステップの実行結果を参照できる。
   * "{requestId}", "{tenantId}", "{userId}" もコンテキストから参照可能。
   */
  path:     string;
  headers?: Record<string, string>;
  query?:   Record<string, string>;
  body?:    Record<string, unknown>;
  /** 失敗時の巻き戻し定義 (省略可) */
  compensation?: StepCompensation;
}

/**
 * 定義駆動オーケストレーション定義。
 * PlatformRequest.payload.orchestration に埋め込む。
 *
 * @example
 * payload: {
 *   orchestration: {
 *     steps: [
 *       { service: "user-service",  method: "POST", path: "/api/users",
 *         body: { email: "u@example.com", name: "Taro" },
 *         compensation: { service: "user-service", method: "DELETE", path: "/api/users/{result.id}" } },
 *       { service: "file-storage-service", method: "POST", path: "/api/files",
 *         body: { userId: "{step0.body.id}", storagePath: "/data/sample.txt" } }
 *     ]
 *   }
 * }
 */
export interface OrchestrationDefinition {
  steps: OrchestrationStep[];
}

/** executeOrchestrationActivity が管理する 1 ステップ分の実行結果 */
export interface StepResult {
  stepIndex: number;
  service:   string;
  status:    number;
  body:      unknown;
}
