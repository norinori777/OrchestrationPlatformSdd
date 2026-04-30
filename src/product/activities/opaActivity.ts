// ─────────────────────────────────────────────────────────────────────────────
// OPA ポリシー評価アクティビティ
// ・指数バックオフ付きリトライ (Temporal のリトライと二重化しない設計)
// ・タイムアウト付きフェッチ (AbortController)
// ─────────────────────────────────────────────────────────────────────────────
import fetch from 'node-fetch';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { PolicyInput } from '../types.ts';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createEvaluatePolicyActivity(config: Config, logger: Logger) {
  const log = logger.child({ activity: 'evaluatePolicyActivity' });
  const url = `${config.opa.baseUrl}/v1/data/${config.opa.policyPath}`;

  return async function evaluatePolicyActivity(input: PolicyInput): Promise<boolean> {
    const actLog = log.child({
      tenantId: input.tenantId,
      userId:   input.userId,
      action:   input.action,
      resource: input.resource,
    });

    for (let attempt = 1; attempt <= config.opa.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.opa.timeoutMs);

      try {
        const res = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ input }),
          // node-fetch の signal 型と AbortController の型が微妙にずれるため as unknown で回避
          signal:  controller.signal as unknown as Parameters<typeof fetch>[1] extends { signal?: infer S } ? S : never,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`OPA HTTP ${res.status}: ${body}`);
        }

        const json = (await res.json()) as { result?: unknown };
        const allowed = Boolean(json.result);
        actLog.info('Policy evaluated', { allowed, attempt });
        return allowed;
      } catch (err: unknown) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);

        if (attempt >= config.opa.maxRetries) {
          actLog.error('Policy evaluation failed after all retries', { msg, attempt });
          throw new Error(`OPA evaluation failed: ${msg}`);
        }

        actLog.warn('Policy evaluation retry', { msg, attempt });
        await sleep(1_000 * attempt); // 指数バックオフ (1s, 2s, 3s…)
      }
    }

    throw new Error('Unreachable');
  };
}
