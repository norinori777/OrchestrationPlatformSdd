// ─────────────────────────────────────────────────────────────────────────────
// opaActivity テスト
//
// テスト対象:
//   - OPA が allow / deny を返すとき正しい boolean を返すこと
//   - HTTP エラーで指数バックオフリトライが走ること
//   - maxRetries 超過後に例外を投げること
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PolicyInput } from '../../types.ts';

// ── グローバル fetch モック ─────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Prometheus メトリクスモック ────────────────────────────────────────────
vi.mock('../../metrics.ts', () => ({
  opaDecisionsTotal:        { inc: vi.fn() },
  opaDecisionDurationSeconds: { startTimer: vi.fn(() => vi.fn()) },
}));

// ── テスト用フィクスチャ ───────────────────────────────────────────────────
const mockLogger = {
  child: () => mockLogger,
  info:  vi.fn(),
  warn:  vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockConfig = {
  opa: {
    baseUrl:    'http://opa:8181',
    policyPath: 'platform/authz/allow',
    timeoutMs:  2_000,
    maxRetries: 3,
  },
} as Parameters<typeof import('../../activities/opaActivity.ts')['createEvaluatePolicyActivity']>[0];

const sampleInput: PolicyInput = {
  tenantId: 'tenant-a',
  userId:   'user-1',
  action:   'create',
  resource: 'files',
};

function mockOkResponse(result: unknown) {
  return {
    ok:   true,
    status: 200,
    text: vi.fn().mockResolvedValue(''),
    json: vi.fn().mockResolvedValue({ result }),
  };
}

function mockErrorResponse(status: number) {
  return {
    ok:   false,
    status,
    text: vi.fn().mockResolvedValue(`HTTP ${status}`),
    json: vi.fn().mockResolvedValue({}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// テストスイート
// ─────────────────────────────────────────────────────────────────────────────
describe('createEvaluatePolicyActivity', () => {
  let evaluatePolicyActivity: ReturnType<typeof import('../../activities/opaActivity.ts')['createEvaluatePolicyActivity']>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // sleep をスタブして待機時間をなくす
    vi.useFakeTimers();
    const mod = await import('../../activities/opaActivity.ts');
    evaluatePolicyActivity = mod.createEvaluatePolicyActivity(mockConfig, mockLogger as never);
  });

  afterEach(() => {
    // タイマーをリセットして unhandled rejection を防ぐ
    vi.useRealTimers();
  });

  it('OPA が { result: true } を返すとき true を返すこと', async () => {
    mockFetch.mockResolvedValue(mockOkResponse(true));

    const result = await evaluatePolicyActivity(sampleInput);
    expect(result).toBe(true);
  });

  it('OPA が { result: false } を返すとき false を返すこと', async () => {
    mockFetch.mockResolvedValue(mockOkResponse(false));

    const result = await evaluatePolicyActivity(sampleInput);
    expect(result).toBe(false);
  });

  it('OPA が { result: null } を返すとき false (falsy) を返すこと', async () => {
    mockFetch.mockResolvedValue(mockOkResponse(null));

    const result = await evaluatePolicyActivity(sampleInput);
    expect(result).toBe(false);
  });

  it('正しい URL / メソッド / ボディで fetch が呼ばれること', async () => {
    mockFetch.mockResolvedValue(mockOkResponse(true));

    await evaluatePolicyActivity(sampleInput);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://opa:8181/v1/data/platform/authz/allow');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ input: sampleInput });
  });

  it('HTTP 500 でリトライして最終的に成功すること', async () => {
    mockFetch
      .mockResolvedValueOnce(mockErrorResponse(500)) // 1 回目失敗
      .mockResolvedValueOnce(mockOkResponse(true));  // 2 回目成功

    // タイマーを進めてバックオフをスキップ
    const promise = evaluatePolicyActivity(sampleInput);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('maxRetries (3) 回すべて失敗したとき例外を投げること', async () => {
    mockFetch.mockResolvedValue(mockErrorResponse(503));

    const promise = evaluatePolicyActivity(sampleInput);
    // rejects ハンドラをタイマー進行前に登録して unhandled rejection を防ぐ
    const assertion = expect(promise).rejects.toThrow('OPA evaluation failed');
    await vi.runAllTimersAsync();
    await assertion;

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
