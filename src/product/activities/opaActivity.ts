// ─────────────────────────────────────────────────────────────────────────────
// OPA ポリシー評価アクティビティ
// ・指数バックオフ付きリトライ (Temporal のリトライと二重化しない設計)
// ・タイムアウト付きフェッチ (AbortController)
// ・OpenTelemetry スパン計装: opa.evaluate_policy
// ─────────────────────────────────────────────────────────────────────────────
import { SpanStatusCode }                          from '@opentelemetry/api';
import { getTracer }                               from '../telemetry.ts';
import { opaDecisionsTotal, opaDecisionDurationSeconds } from '../metrics.ts';
import type { Config }      from '../config.ts';
import type { Logger }      from '../logger.ts';
import type { PolicyInput } from '../types.ts';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createEvaluatePolicyActivity(config: Config, logger: Logger) {
  const log    = logger.child({ activity: 'evaluatePolicyActivity' });
  const tracer = getTracer('platform.opa');
  const url    = `${config.opa.baseUrl}/v1/data/${config.opa.policyPath}`;

  return async function evaluatePolicyActivity(input: PolicyInput): Promise<boolean> {
    const actLog = log.child({
      tenantId: input.tenantId,
      userId:   input.userId,
      action:   input.action,
      resource: input.resource,
    });

    return tracer.startActiveSpan('opa.evaluate_policy', async (span) => {
      span.setAttributes({
        'platform.tenant_id': input.tenantId,
        'platform.user_id':   input.userId,
        'platform.action':    input.action,
        'platform.resource':  input.resource,
        'rpc.system':         'opa',
        'server.address':     config.opa.baseUrl,
        'opa.policy_path':    config.opa.policyPath,
      });

      let lastAttempt = 0;

      try {
        for (let attempt = 1; attempt <= config.opa.maxRetries; attempt++) {
          lastAttempt = attempt;
          const controller = new AbortController();
          const timer      = setTimeout(() => controller.abort(), config.opa.timeoutMs);
          const endTimer   = opaDecisionDurationSeconds.startTimer();

          try {
            const res = await fetch(url, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ input }),
              signal:  controller.signal,
            });

            clearTimeout(timer);

            if (!res.ok) {
              const body = await res.text();
              throw new Error(`OPA HTTP ${res.status}: ${body}`);
            }

            const json = (await res.json()) as { result?: unknown };
            const allowed = Boolean(json.result);

            opaDecisionsTotal.inc({ result: allowed ? 'allow' : 'deny' });
            endTimer();

            span.setAttributes({
              'opa.result':      allowed ? 'allow' : 'deny',
              'opa.attempt_count': attempt,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            actLog.info('Policy evaluated', { allowed, attempt });
            span.end();
            return allowed;
          } catch (err: unknown) {
            clearTimeout(timer);
            const msg = err instanceof Error ? err.message : String(err);

            if (attempt >= config.opa.maxRetries) {
              actLog.error('Policy evaluation failed after all retries', { msg, attempt });
              throw new Error(`OPA evaluation failed: ${msg}`);
            }

            actLog.warn('Policy evaluation retry', { msg, attempt });
            await sleep(1_000 * attempt);
          }
        }

        throw new Error('Unreachable');
      } catch (err: unknown) {
        span.setAttributes({ 'opa.attempt_count': lastAttempt });
        span.recordException(err as Error);
        span.setStatus({
          code:    SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }
    });
  };
}
