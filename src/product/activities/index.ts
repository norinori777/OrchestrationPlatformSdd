// ─────────────────────────────────────────────────────────────────────────────
// アクティビティレジストリ
// ワーカーへ渡す activities オブジェクトと、ワークフローが型推論で使う
// PlatformActivities 型をここで一元管理します。
// ─────────────────────────────────────────────────────────────────────────────
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { PlatformRequest, PolicyInput, NotificationPayload, RequestStatus } from '../types.ts';
import { createEvaluatePolicyActivity }   from './opaActivity.ts';
import { createSendNotificationActivity } from './notificationActivity.ts';
import { createPersistRequestActivity }   from './persistenceActivity.ts';

// ─────────────────────────────────────────────────────────────────────────────
// ドメインロジック アクティビティ
// action / resource に応じてハンドラを切り替える拡張ポイントです。
// ─────────────────────────────────────────────────────────────────────────────
async function processRequestActivity(request: PlatformRequest): Promise<string> {
  // 実運用では action × resource のマトリクスで専用ハンドラへディスパッチします:
  // const handler = handlers[`${request.action}:${request.resource}`];
  // if (!handler) throw new Error(`No handler for ${request.action}:${request.resource}`);
  // return handler(request);
  return `Processed: ${request.action} on ${request.resource} (tenant: ${request.tenantId}, reqId: ${request.requestId})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ファクトリ — config/logger を DI してワーカーへ渡すオブジェクトを生成
// ─────────────────────────────────────────────────────────────────────────────
export function createActivities(config: Config, logger: Logger) {
  return {
    evaluatePolicyActivity:   createEvaluatePolicyActivity(config, logger),
    sendNotificationActivity: createSendNotificationActivity(config, logger),
    persistRequestActivity:   createPersistRequestActivity(config, logger),
    processRequestActivity,
  };
}

/** ワークフロー側で proxyActivities に渡す型 */
export type PlatformActivities = {
  evaluatePolicyActivity(input: PolicyInput): Promise<boolean>;
  processRequestActivity(request: PlatformRequest): Promise<string>;
  sendNotificationActivity(payload: NotificationPayload): Promise<void>;
  persistRequestActivity(request: PlatformRequest, status: RequestStatus): Promise<void>;
};
