// ─────────────────────────────────────────────────────────────────────────────
// persistenceActivity テスト
//
// テスト対象:
//   - platform_requests への upsert (create / update)
//   - SaaS Backend へのコールバック (成功 / 失敗 / 404)
//   - コールバック失敗でもワークフローが止まらないこと (ベストエフォート)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformRequest } from '../../types.ts';

// ── upsert モック ─────────────────────────────────────────────────────────────
const mockUpsert = vi.fn().mockResolvedValue({});

// PrismaClient は DI で渡す — モジュールモック不要
const mockPrisma = {
  platformRequest: { upsert: mockUpsert },
};

// ── global fetch モック ────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── テスト用フィクスチャ ───────────────────────────────────────────────────
const mockLogger = {
  child: () => mockLogger,
  info:  vi.fn(),
  warn:  vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockConfig = {
  saasBackendUrl: 'http://saas-backend:3001',
} as Parameters<typeof import('../../activities/persistenceActivity.ts')['createPersistRequestActivity']>[0];

const sampleRequest: PlatformRequest = {
  requestId: 'req-001',
  tenantId:  'tenant-a',
  userId:    'user-1',
  action:    'create',
  resource:  'files',
  payload:   { filename: 'test.txt', storagePath: '/uploads/test.txt' },
};

// ─────────────────────────────────────────────────────────────────────────────
// テストスイート
// ─────────────────────────────────────────────────────────────────────────────
describe('createPersistRequestActivity', () => {
  let persistRequestActivity: ReturnType<typeof import('../../activities/persistenceActivity.ts')['createPersistRequestActivity']>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../activities/persistenceActivity.ts');
    persistRequestActivity = mod.createPersistRequestActivity(mockConfig, mockLogger as never, mockPrisma as never);
  });

  // ── DB upsert ─────────────────────────────────────────────────────────────

  it('pending ステータスで upsert が呼ばれること', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await persistRequestActivity(sampleRequest, 'pending');

    expect(mockUpsert).toHaveBeenCalledOnce();
    const arg = mockUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['where']).toEqual({ id: 'req-001' });
    expect((arg['create'] as Record<string, unknown>)['status']).toBe('pending');
    expect((arg['update'] as Record<string, unknown>)['status']).toBe('pending');
  });

  it('completed + result で upsert の create/update 両方に result が含まれること', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await persistRequestActivity(sampleRequest, 'completed', 'File created: id=req-001');

    const arg = mockUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((arg['create'] as Record<string, unknown>)['result']).toBe('File created: id=req-001');
    expect((arg['update'] as Record<string, unknown>)['result']).toBe('File created: id=req-001');
  });

  it('result が undefined のとき upsert の update に result キーが含まれないこと', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await persistRequestActivity(sampleRequest, 'pending');

    const arg = mockUpsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((arg['update'] as Record<string, unknown>)).not.toHaveProperty('result');
  });

  // ── コールバック URL ───────────────────────────────────────────────────────

  it('コールバックが正しい URL / メソッド / ボディで呼ばれること', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await persistRequestActivity(sampleRequest, 'completed', 'done');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://saas-backend:3001/api/requests/req-001/status');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ status: 'completed', result: 'done' });
  });

  // ── ベストエフォート — コールバック失敗でも例外を投げない ─────────────────

  it('コールバックが HTTP 500 でも例外を投げないこと (ベストエフォート)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(persistRequestActivity(sampleRequest, 'completed')).resolves.toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledOnce(); // DB 書き込みは成功
  });

  it('コールバックが 404 のとき warn を出さないこと', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await persistRequestActivity(sampleRequest, 'completed');

    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const hasCallbackWarn = warnCalls.some((args) =>
      String(args[0]).includes('callback'),
    );
    expect(hasCallbackWarn).toBe(false);
  });

  it('コールバックがネットワーク例外でも例外を投げないこと', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(persistRequestActivity(sampleRequest, 'failed')).resolves.toBeUndefined();
  });

  it('DB upsert 失敗は例外を投げること', async () => {
    mockUpsert.mockRejectedValue(new Error('DB connection lost'));
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await expect(persistRequestActivity(sampleRequest, 'pending')).rejects.toThrow('DB connection lost');
  });

  it('Prisma P2002 (Unique constraint) のとき DuplicateRequestError を投げること', async () => {
    const p2002 = Object.assign(new Error('Unique constraint violation'), { code: 'P2002' });
    mockUpsert.mockRejectedValue(p2002);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const { DuplicateRequestError } = await import('../../activities/persistenceActivity.ts');
    await expect(persistRequestActivity(sampleRequest, 'pending')).rejects.toThrow(DuplicateRequestError);
  });
});
