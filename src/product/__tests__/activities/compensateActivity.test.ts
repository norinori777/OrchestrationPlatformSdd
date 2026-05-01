// ─────────────────────────────────────────────────────────────────────────────
// compensateRequestActivity テスト
//
// テスト対象 (index.ts の compensationHandlers):
//   - create:files → FileStorageService DELETE
//   - create:users → UserService DELETE
//   - 404 は冪等成功として扱うこと
//   - HTTP エラーで例外を投げること
//   - 補償なし (read/delete) は固定メッセージを返すこと
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformRequest } from '../../types.ts';

// ── global fetch モック ────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── アクティビティ依存のモック (createActivities には不要な依存が多いので直接呼ぶ) ─
vi.mock('../../activities/opaActivity.ts',          () => ({ createEvaluatePolicyActivity:   vi.fn() }));
vi.mock('../../activities/notificationActivity.ts', () => ({ createSendNotificationActivity: vi.fn() }));
vi.mock('../../activities/persistenceActivity.ts',  () => ({ createPersistRequestActivity:   vi.fn() }));
vi.mock('../../activities/quotaActivity.ts',        () => ({ createCheckQuotaActivity:       vi.fn() }));
vi.mock('../../metrics.ts', () => ({
  opaDecisionsTotal:          { inc: vi.fn() },
  opaDecisionDurationSeconds: { startTimer: vi.fn(() => vi.fn()) },
  quotaChecksTotal:           { inc: vi.fn() },
}));

// ─────────────────────────────────────────────────────────────────────────────
// テストスイート
// ─────────────────────────────────────────────────────────────────────────────
describe('compensateRequestActivity', () => {
  let compensate: (req: PlatformRequest) => Promise<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // createActivities を経由せず、内部関数を直接取得するため
    // index.ts のモジュールを再インポートしてエクスポートされていない関数は
    // createActivities の戻り値から取得する
    const mod = await import('../../activities/index.ts');
    const activities = mod.createActivities(
      {} as never,
      { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as never,
      {} as never,
      { publish: vi.fn() } as never,  // NatsConnection mock
    );
    compensate = activities.compensateRequestActivity;
  });

  // ── create:files ─────────────────────────────────────────────────────────

  it('create:files — DELETE が requestId で呼ばれること', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204, json: vi.fn() });

    const req: PlatformRequest = {
      requestId: 'req-001', tenantId: 'tenant-a',
      userId: 'u1', action: 'create', resource: 'files', payload: {},
    };

    const result = await compensate(req);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/files/req-001');
    expect((opts.headers as Record<string, string>)['X-Tenant-Id']).toBe('tenant-a');
    expect(opts.method).toBe('DELETE');
    expect(result).toContain('compensation completed');
  });

  it('create:files — 404 は冪等成功として skipped メッセージを返すこと', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const req: PlatformRequest = {
      requestId: 'req-002', tenantId: 'tenant-a',
      userId: 'u1', action: 'create', resource: 'files', payload: {},
    };

    const result = await compensate(req);
    expect(result).toContain('skipped');
  });

  it('create:files — HTTP 500 で例外を投げること', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const req: PlatformRequest = {
      requestId: 'req-003', tenantId: 'tenant-a',
      userId: 'u1', action: 'create', resource: 'files', payload: {},
    };

    await expect(compensate(req)).rejects.toThrow('HTTP 500');
  });

  // ── create:users ─────────────────────────────────────────────────────────

  it('create:users — DELETE が requestId で呼ばれること', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204, json: vi.fn() });

    const req: PlatformRequest = {
      requestId: 'req-004', tenantId: 'tenant-a',
      userId: 'u1', action: 'create', resource: 'users', payload: {},
    };

    const result = await compensate(req);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/api/users/req-004');
    expect(result).toContain('compensation completed');
  });

  it('create:users — 404 は冪等成功であること', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const req: PlatformRequest = {
      requestId: 'req-005', tenantId: 'tenant-a',
      userId: 'u1', action: 'create', resource: 'users', payload: {},
    };

    await expect(compensate(req)).resolves.toContain('skipped');
  });

  // ── 補償なし (read / delete) ───────────────────────────────────────────

  it('read:files — 補償ハンドラなし → "No compensation" メッセージを返すこと', async () => {
    const req: PlatformRequest = {
      requestId: 'req-006', tenantId: 'tenant-a',
      userId: 'u1', action: 'read', resource: 'files', payload: {},
    };

    const result = await compensate(req);
    expect(result).toContain('No compensation');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('delete:users — 補償ハンドラなし → fetch が呼ばれないこと', async () => {
    const req: PlatformRequest = {
      requestId: 'req-007', tenantId: 'tenant-a',
      userId: 'u1', action: 'delete', resource: 'users', payload: {},
    };

    await compensate(req);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
