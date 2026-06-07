// ─────────────────────────────────────────────────────────────────────────────
// 定義駆動オーケストレーション アクティビティ
//
// PlatformRequest.payload.orchestration に OrchestrationDefinition を渡すと、
// steps を先頭から順番に HTTP 呼び出しし、途中で失敗した場合は
// 実行済みステップを逆順に compensation で巻き戻す (Saga パターン)。
//
// ■ テンプレート補間
//   path / body / headers / query 内の "{...}" プレースホルダーは実行時に置換される。
//   ・{step0.body.id}  — 0 番目ステップのレスポンスボディの id フィールド
//   ・{step1.status}   — 1 番目ステップの HTTP ステータスコード
//   ・{requestId}      — リクエスト ID
//   ・{tenantId}       — テナント ID
//   ・{userId}         — ユーザー ID
//   補償定義では {result.xxx} で「そのステップ自身の実行結果」を参照できる。
//
// ■ カスタマイズ
//   ・SERVICE_REGISTRY_PATH でサービス URL の manifest を差し替えられる。
//   ・ORCHESTRATION_CATALOG_PATH で orchestration 定義の manifest を追加できる。
// ─────────────────────────────────────────────────────────────────────────────
import { SpanStatusCode } from '@opentelemetry/api';
import { readFile }       from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getTracer }      from '../telemetry.ts';
import type {
  PlatformRequest,
  OrchestrationDefinition,
  OrchestrationStep,
  StepResult,
} from '../types.ts';
import { ORCHESTRATION_CATALOG } from '../orchestrations/catalog.ts';

// ─────────────────────────────────────────────────────────────────────────────
// サービスレジストリ — サービス名 → ベース URL
// デフォルトは環境変数、必要に応じて JSON manifest で拡張できる
// ─────────────────────────────────────────────────────────────────────────────
type ServiceRegistry = Record<string, string>;

type OrchestrationCatalog = Record<string, OrchestrationDefinition>;

const DEFAULT_SERVICE_REGISTRY: ServiceRegistry = {
  'user-service':         process.env.USER_SERVICE_URL          ?? 'http://localhost:4002',
  'file-storage-service': process.env.FILE_STORAGE_SERVICE_URL  ?? 'http://localhost:4001',
  'mail-service':         process.env.MAIL_SERVICE_URL          ?? 'http://localhost:4004',
  'routing-file-service': process.env.ROUTING_FILE_SERVICE_URL  ?? 'http://localhost:4003',
};

let serviceRegistryCache: ServiceRegistry | undefined;
let orchestrationCatalogCache: OrchestrationCatalog | undefined;

function normalizeCatalog(raw: unknown): OrchestrationCatalog {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Orchestration catalog manifest must be a JSON object keyed by orchestrationId');
  }

  const catalog: OrchestrationCatalog = {};
  for (const [id, definition] of Object.entries(raw)) {
    if (!definition || typeof definition !== 'object' || !Array.isArray((definition as { steps?: unknown }).steps)) {
      throw new Error(`Invalid orchestration definition for "${id}" in manifest`);
    }
    catalog[id] = definition as OrchestrationDefinition;
  }

  return catalog;
}

async function loadJsonManifest<T>(manifestPath: string): Promise<T> {
  const absolutePath = resolvePath(process.cwd(), manifestPath);
  const content = await readFile(absolutePath, 'utf8');
  return JSON.parse(content) as T;
}

async function loadServiceRegistry(): Promise<ServiceRegistry> {
  if (serviceRegistryCache) {
    return serviceRegistryCache;
  }

  const manifestPath = process.env.SERVICE_REGISTRY_PATH;
  if (!manifestPath) {
    serviceRegistryCache = DEFAULT_SERVICE_REGISTRY;
    return serviceRegistryCache;
  }

  const manifest = await loadJsonManifest<Record<string, string>>(manifestPath);
  serviceRegistryCache = { ...DEFAULT_SERVICE_REGISTRY, ...manifest };
  return serviceRegistryCache;
}

async function loadOrchestrationCatalog(): Promise<OrchestrationCatalog> {
  if (orchestrationCatalogCache) {
    return orchestrationCatalogCache;
  }

  const manifestPath = process.env.ORCHESTRATION_CATALOG_PATH;
  if (!manifestPath) {
    orchestrationCatalogCache = ORCHESTRATION_CATALOG;
    return orchestrationCatalogCache;
  }

  const manifest = await loadJsonManifest<Record<string, OrchestrationDefinition>>(manifestPath);
  orchestrationCatalogCache = { ...ORCHESTRATION_CATALOG, ...normalizeCatalog(manifest) };
  return orchestrationCatalogCache;
}

async function resolveServiceUrl(service: string): Promise<string> {
  const registry = await loadServiceRegistry();
  const url = registry[service];
  if (!url) {
    throw new Error(
      `Service "${service}" is not registered. ` +
      `Set SERVICE_REGISTRY_PATH or add a service URL entry for this deployment.`,
    );
  }
  return url;
}

export async function resolveOrchestrationDefinitionActivity(orchestrationId: string): Promise<OrchestrationDefinition> {
  const catalog = await loadOrchestrationCatalog();
  const orchestration = catalog[orchestrationId];

  if (!orchestration) {
    throw new Error(
      `Orchestration "${orchestrationId}" is not registered. ` +
      `Set ORCHESTRATION_CATALOG_PATH or keep the definition in the built-in catalog.`,
    );
  }

  return orchestration;
}

// ─────────────────────────────────────────────────────────────────────────────
// テンプレート補間ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/** "{step0.body.id}" のようなパスを context オブジェクトのドット記法で解決する */
function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (match, path: string) => {
    const parts = path.split('.');
    let value: unknown = context;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') return match;
      value = (value as Record<string, unknown>)[part];
    }
    return value != null ? String(value) : match;
  });
}

/** オブジェクト / 配列 / 文字列を再帰的に補間する */
function interpolateDeep<T>(obj: T, context: Record<string, unknown>): T {
  if (typeof obj === 'string') return interpolate(obj, context) as unknown as T;
  if (Array.isArray(obj))     return obj.map(item => interpolateDeep(item, context)) as unknown as T;
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateDeep(val, context);
    }
    return result as unknown as T;
  }
  return obj;
}

/** 補間コンテキストを組み立てる — step 番号ごとに結果を保持する */
function buildContext(request: PlatformRequest, results: StepResult[]): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    requestId: request.requestId,
    tenantId:  request.tenantId,
    userId:    request.userId,
    payload:   request.payload,
  };
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r) ctx[`step${i}`] = { body: r.body, status: r.status };
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// 補償実行 (Saga パターン) — 実行済みステップを逆順に巻き戻す
// ─────────────────────────────────────────────────────────────────────────────
async function runCompensations(
  request:     PlatformRequest,
  steps:       OrchestrationStep[],
  stepResults: StepResult[],
): Promise<void> {
  for (let j = stepResults.length - 1; j >= 0; j--) {
    const prevStep = steps[j];
    if (!prevStep) continue;
    const comp = prevStep.compensation;
    if (!comp) continue;
    const prevResult = stepResults[j];
    if (!prevResult) continue;

    const ctx      = { ...buildContext(request, stepResults), result: prevResult.body };
    const baseUrl  = await resolveServiceUrl(comp.service);
    const compPath = interpolate(comp.path, ctx);
    const compBody = comp.body    ? interpolateDeep(comp.body,    ctx) : undefined;
    const compHdrs = comp.headers ? interpolateDeep(comp.headers, ctx) as Record<string, string> : {};
    const compQry  = comp.query   ? interpolateDeep(comp.query,   ctx) as Record<string, string> : undefined;

    let compUrl = `${baseUrl}${compPath}`;
    if (compQry) compUrl += `?${new URLSearchParams(compQry).toString()}`;

    const compFetchBody: string | null = compBody != null ? JSON.stringify(compBody) : null;
    try {
      const res = await fetch(compUrl, {
        method:  comp.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id':  request.tenantId,
          ...compHdrs,
        },
        body:   compFetchBody,
        signal: AbortSignal.timeout(10_000),
      });
      // HTTP 404 は「補償対象が既に存在しない」として正常扱い
      if (!res.ok && res.status !== 404) {
        console.error(
          `[orchestration] Compensation failed step ${j}` +
          ` (${comp.service} ${comp.method} ${compPath}): HTTP ${res.status}`,
        );
      }
    } catch (compErr) {
      console.error(`[orchestration] Compensation error at step ${j}:`, compErr);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// メインアクティビティ
// ─────────────────────────────────────────────────────────────────────────────
export async function executeOrchestrationActivity(request: PlatformRequest): Promise<string> {
  const orchestration = request.payload.orchestration as OrchestrationDefinition | undefined;

  if (!orchestration?.steps?.length) {
    throw new Error(
      'executeOrchestrationActivity: orchestration.steps が payload に定義されていません',
    );
  }

  const steps       = orchestration.steps;
  const stepResults: StepResult[] = [];
  const tracer      = getTracer('platform.orchestration');

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;  // noUncheckedIndexedAccess ガード
    const baseUrl         = await resolveServiceUrl(step.service);
    const ctx             = buildContext(request, stepResults);
    const resolvedPath    = interpolate(step.path, ctx);
    const resolvedBody    = step.body    ? interpolateDeep(step.body,    ctx) : undefined;
    const resolvedHeaders = step.headers ? interpolateDeep(step.headers, ctx) as Record<string, string> : {};
    const resolvedQuery   = step.query   ? interpolateDeep(step.query,   ctx) as Record<string, string> : undefined;

    let url = `${baseUrl}${resolvedPath}`;
    if (resolvedQuery) url += `?${new URLSearchParams(resolvedQuery).toString()}`;

    try {
      await tracer.startActiveSpan(`orchestration.step${i}.${step.service}`, async (span) => {
        span.setAttributes({
          'orchestration.step_index': i,
          'orchestration.service':    step.service,
          'http.request.method':      step.method,
          'url.full':                 url,
          'platform.request_id':      request.requestId,
          'platform.tenant_id':       request.tenantId,
        });

        try {
          const res = await fetch(url, {
            method:  step.method,
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Id':  request.tenantId,
              'X-Request-Id': request.requestId,
              ...resolvedHeaders,
            },
            body:   resolvedBody != null ? JSON.stringify(resolvedBody) : null,
            signal: AbortSignal.timeout(10_000),
          });

          const responseBody = await res.json().catch(() => null);

          if (!res.ok) {
            throw new Error(
              `Step ${i} (${step.service} ${step.method} ${resolvedPath}): HTTP ${res.status}`,
            );
          }

          stepResults.push({
            stepIndex: i,
            service:   step.service,
            status:    res.status,
            body:      responseBody,
          });

          span.setAttribute('orchestration.step_status', res.status);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        } catch (err: unknown) {
          span.recordException(err as Error);
          span.setStatus({
            code:    SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          span.end();
          throw err;
        }
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // 実行済みステップを逆順に補償して Saga を完結させる
      await runCompensations(request, steps, stepResults);

      throw new Error(`Orchestration failed at step ${i}: ${errorMessage}`);
    }
  }

  const routingResult = stepResults[stepResults.length - 1]?.body ?? null;

  return JSON.stringify({
    orchestrationSteps: steps.length,
    summary: `Orchestration completed [${steps.length} steps]`,
    stepResults,
    routingResult,
  });
}
