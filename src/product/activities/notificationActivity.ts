// ─────────────────────────────────────────────────────────────────────────────
// 通知アクティビティ
//
// 2 つのバックエンドへベストエフォートで通知を配信する:
//   1. NATS パブリッシュ — platform.notifications.{tenantId} へ publish
//      フロントエンドや他のサービスがサブジェクトを subscribe して
//      リアルタイム通知を受け取れる
//   2. HTTP Webhook — NOTIFICATION_WEBHOOK_URL が設定されている場合に
//      Slack / Teams / カスタムエンドポイントへ POST
//
// ・どちらかが失敗してもワークフローは止めない (ベストエフォート)
// ・OpenTelemetry スパン計装: notification.send
// ─────────────────────────────────────────────────────────────────────────────
import { StringCodec, type NatsConnection } from 'nats';
import { SpanStatusCode }                   from '@opentelemetry/api';
import { getTracer }                        from '../telemetry.ts';
import { notificationsSentTotal, notificationsFailedTotal } from '../metrics.ts';
import type { Config }               from '../config.ts';
import type { Logger }               from '../logger.ts';
import type { NotificationPayload }  from '../types.ts';

const sc = StringCodec();

export function createSendNotificationActivity(
  config: Config,
  logger: Logger,
  nc: NatsConnection,
) {
  const log    = logger.child({ activity: 'sendNotificationActivity' });
  const tracer = getTracer('platform.notification');

  return async function sendNotificationActivity(payload: NotificationPayload): Promise<void> {
    const actLog = log.child({
      requestId: payload.requestId,
      tenantId:  payload.tenantId,
      status:    payload.status,
    });

    await tracer.startActiveSpan('notification.send', async (span) => {
      span.setAttributes({
        'platform.tenant_id':  payload.tenantId,
        'platform.user_id':    payload.userId,
        'platform.request_id': payload.requestId,
        'notification.status': payload.status,
      });

      const errors: string[] = [];

      // ── 1. NATS パブリッシュ ─────────────────────────────────────────────
      const natsSubject = `${config.notification.natsSubject}.${payload.tenantId}`;
      try {
        nc.publish(natsSubject, sc.encode(JSON.stringify(payload)));
        span.setAttribute('notification.nats.subject', natsSubject);
        actLog.debug('Notification published to NATS', { subject: natsSubject });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`nats: ${msg}`);
        actLog.warn('NATS notification publish failed', { err: msg, subject: natsSubject });
      }

      // ── 2. HTTP Webhook ───────────────────────────────────────────────────
      if (config.notification.webhookUrl) {
        try {
          const res = await fetch(config.notification.webhookUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              service:   'orchestration-platform',
              requestId: payload.requestId,
              tenantId:  payload.tenantId,
              userId:    payload.userId,
              status:    payload.status,
              message:   payload.message,
              timestamp: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(config.notification.webhookTimeoutMs),
          });
          span.setAttribute('notification.webhook.status_code', res.status);
          if (!res.ok) {
            errors.push(`webhook: HTTP ${res.status}`);
            actLog.warn('Webhook notification failed', { httpStatus: res.status });
          } else {
            actLog.debug('Webhook notification sent');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`webhook: ${msg}`);
          actLog.warn('Webhook notification error (ignored)', { err: msg });
        }
      }

      // ── 結果集計 ──────────────────────────────────────────────────────────
      if (errors.length > 0) {
        notificationsFailedTotal.inc({ status: payload.status });
        span.setStatus({ code: SpanStatusCode.ERROR, message: errors.join('; ') });
        // 通知失敗はワークフローを止めない
        actLog.warn('Notification dispatch had errors (non-fatal)', {
          errors,
          message: payload.message,
        });
      } else {
        notificationsSentTotal.inc({ status: payload.status });
        span.setStatus({ code: SpanStatusCode.OK });
        actLog.info('Notification dispatched', { message: payload.message });
      }

      span.end();
    });
  };
}
