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
  status: 'allowed' | 'denied' | 'error';
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
