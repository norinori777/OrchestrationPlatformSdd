// ─────────────────────────────────────────────────────────────────────────────
// プラットフォーム ワークフロー定義
//
// ⚠️  このファイルは Temporal の Workflow Sandbox (deterministic VM) で実行されます。
//     Node.js の IO (fetch, fs, setTimeout など) は使用できません。
//     すべての IO はアクティビティ経由で行います。
//
// フロー:
//   1. リクエストを DB へ保存 (pending)
//   2. OPA でポリシー評価
//   3. 拒否の場合 → 通知 → denied で終了
//   4. 許可の場合 → ビジネスロジック処理
//   5. 完了通知 → DB 更新 (completed)
//
// Signals: cancel — 実行中のワークフローをキャンセル
// Queries: getStatus — 現在ステータス文字列を返す
// ─────────────────────────────────────────────────────────────────────────────
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  log,
} from '@temporalio/workflow';
import type { PlatformRequest, PlatformResponse, PolicyInput, NotificationPayload } from '../types.ts';
import type { PlatformActivities } from '../activities/index.ts';

// アクティビティプロキシ — タイムアウト・リトライポリシーを設定
const {
  evaluatePolicyActivity,
  processRequestActivity,
  sendNotificationActivity,
  persistRequestActivity,
} = proxyActivities<PlatformActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts:    3,
    initialInterval:    '1 second',
    backoffCoefficient: 2,
    maximumInterval:    '30 seconds',
    // ポリシー違反はリトライしない
    nonRetryableErrorTypes: ['PolicyViolation'],
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal / Query 定義
// ─────────────────────────────────────────────────────────────────────────────
export const cancelSignal   = defineSignal('cancel');
export const getStatusQuery = defineQuery<string>('getStatus');

// ─────────────────────────────────────────────────────────────────────────────
// メインワークフロー
// ─────────────────────────────────────────────────────────────────────────────
export async function platformWorkflow(request: PlatformRequest): Promise<PlatformResponse> {
  let cancelled    = false;
  let currentStatus = 'started';

  setHandler(cancelSignal,   () => { cancelled = true; });
  setHandler(getStatusQuery, () => currentStatus);

  // キャンセル早期チェック
  if (cancelled) {
    return response(request.requestId, 'error', 'Cancelled before processing');
  }

  // ── Step 1: リクエストを DB に保存 (pending) ──────────────────────────
  currentStatus = 'persisting';
  await persistRequestActivity(request, 'pending');

  // ── Step 2: OPA ポリシー評価 ──────────────────────────────────────────
  currentStatus = 'evaluating-policy';
  log.info('Evaluating policy', {
    requestId: request.requestId,
    userId:    request.userId,
    action:    request.action,
    resource:  request.resource,
  });

  const policyInput: PolicyInput = {
    tenantId: request.tenantId,
    userId:   request.userId,
    action:   request.action,
    resource: request.resource,
  };

  const allowed = await evaluatePolicyActivity(policyInput);

  // ── Step 3: 拒否パス ────────────────────────────────────────────────────
  if (!allowed) {
    currentStatus = 'denied';
    log.warn('Request denied by policy', { requestId: request.requestId });

    const denyMsg = `Action "${request.action}" on "${request.resource}" is denied for user "${request.userId}"`;
    const notification: NotificationPayload = {
      tenantId:  request.tenantId,
      userId:    request.userId,
      requestId: request.requestId,
      status:    'denied',
      message:   denyMsg,
    };

    await sendNotificationActivity(notification);
    await persistRequestActivity(request, 'denied');

    return response(request.requestId, 'denied', denyMsg);
  }

  // ── Step 4: ビジネスロジック処理 ──────────────────────────────────────
  currentStatus = 'processing';
  log.info('Processing request', { requestId: request.requestId });

  if (cancelled) {
    await persistRequestActivity(request, 'failed');
    return response(request.requestId, 'error', 'Cancelled during processing');
  }

  const result = await processRequestActivity(request);

  // ── Step 5: 成功通知 + DB 更新 ────────────────────────────────────────
  currentStatus = 'notifying';
  await sendNotificationActivity({
    tenantId:  request.tenantId,
    userId:    request.userId,
    requestId: request.requestId,
    status:    'allowed',
    message:   result,
  });

  await persistRequestActivity(request, 'completed');
  currentStatus = 'completed';

  log.info('Request completed', { requestId: request.requestId });
  return response(request.requestId, 'allowed', result);
}

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────────────
function response(
  requestId: string,
  status: PlatformResponse['status'],
  message: string,
): PlatformResponse {
  return { requestId, status, message, processedAt: new Date().toISOString() };
}
