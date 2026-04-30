// ─────────────────────────────────────────────────────────────────────────────
// 通知アクティビティ
// 実運用では以下のいずれかに差し替えてください:
//   - Email    : SendGrid / Amazon SES
//   - Slack    : Incoming Webhook
//   - Internal : NATS publish / HTTP webhook
// ─────────────────────────────────────────────────────────────────────────────
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { NotificationPayload } from '../types.ts';

export function createSendNotificationActivity(_config: Config, logger: Logger) {
  const log = logger.child({ activity: 'sendNotificationActivity' });

  return async function sendNotificationActivity(payload: NotificationPayload): Promise<void> {
    const actLog = log.child({
      requestId: payload.requestId,
      tenantId:  payload.tenantId,
      status:    payload.status,
    });

    // ── 実装例 (Webhook) ──────────────────────────────────────────────────
    // const webhookUrl = await resolveWebhookForTenant(payload.tenantId);
    // const res = await fetch(webhookUrl, {
    //   method:  'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body:    JSON.stringify(payload),
    // });
    // if (!res.ok) throw new Error(`Webhook failed: ${res.status}`);
    // ─────────────────────────────────────────────────────────────────────

    actLog.info('Notification dispatched', { message: payload.message });
  };
}
