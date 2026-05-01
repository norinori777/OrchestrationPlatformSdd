// ─────────────────────────────────────────────────────────────────────────────
// platformWorkflow テスト (@temporalio/testing)
//
// TestWorkflowEnvironment を使い、すべてのアクティビティをモックに置き換えて
// ワークフロー全体を単体テストする。
//
// テストシナリオ:
//   1. 正常完了 (allowed → completed)
//   2. OPA 拒否 (denied)
//   3. クォータ超過 (quota-exceeded)
//   4. キャンセルシグナル (failed)
//   5. 業務処理失敗 + Saga 補償 (create → compensate → failed)
//   6. 業務処理失敗 (read → failed, 補償なし)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment }                    from '@temporalio/testing';
import { Worker, Runtime, DefaultLogger }             from '@temporalio/worker';
import { WorkflowFailedError }                        from '@temporalio/client';
import { fileURLToPath }                              from 'node:url';
import { platformWorkflow, cancelSignal }             from '../../workflows/platformWorkflow.ts';
import type { PlatformRequest, PlatformResponse }     from '../../types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 共通フィクスチャ
// ─────────────────────────────────────────────────────────────────────────────
const baseRequest: PlatformRequest = {
  requestId: 'wf-test-001',
  tenantId:  'tenant-a',
  userId:    'user-1',
  action:    'create',
  resource:  'files',
  payload:   { filename: 'test.txt', storagePath: '/uploads/test.txt' },
};

// ─────────────────────────────────────────────────────────────────────────────
// テスト環境のセットアップ
// ─────────────────────────────────────────────────────────────────────────────
let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  // テスト用の軽量ランタイム (外部依存なし)
  Runtime.install({ logger: new DefaultLogger('WARN') });
  testEnv = await TestWorkflowEnvironment.createLocal();
}, 30_000);

afterAll(async () => {
  await testEnv?.teardown();
});

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: モックアクティビティ付きワーカーを起動してワークフローを実行
// ─────────────────────────────────────────────────────────────────────────────
async function runWorkflow(
  request: PlatformRequest,
  activities: Record<string, (...args: unknown[]) => unknown>,
  workflowId?: string,
): Promise<PlatformResponse> {
  const worker = await Worker.create({
    connection:    testEnv.nativeConnection,
    taskQueue:     'test-queue',
    workflowsPath: fileURLToPath(new URL('../../workflows/platformWorkflow.ts', import.meta.url)),
    activities,
  });

  return await worker.runUntil(
    testEnv.client.workflow.execute(platformWorkflow, {
      taskQueue:  'test-queue',
      workflowId: workflowId ?? `test-${Date.now()}`,
      args:       [request],
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// モックアクティビティのデフォルトセット (正常系)
// ─────────────────────────────────────────────────────────────────────────────
const defaultActivities = {
  persistRequestActivity:   async () => undefined,
  evaluatePolicyActivity:   async () => true,
  checkQuotaActivity:       async () => ({ allowed: true, current: 1, limit: 100 }),
  processRequestActivity:   async () => 'File created: id=wf-test-001',
  sendNotificationActivity: async () => undefined,
  compensateRequestActivity: async () => 'compensation skipped',
};

// ─────────────────────────────────────────────────────────────────────────────
// テストスイート
// ─────────────────────────────────────────────────────────────────────────────
describe('platformWorkflow', () => {

  // ── 1. 正常完了 ──────────────────────────────────────────────────────────

  it('正常系: allowed → completed を返すこと', async () => {
    const result = await runWorkflow(baseRequest, defaultActivities);

    expect(result.status).toBe('allowed');
    expect(result.requestId).toBe('wf-test-001');
    expect(result.message).toContain('File created');
  });

  // ── 2. OPA 拒否 ──────────────────────────────────────────────────────────

  it('OPA 拒否: denied を返すこと', async () => {
    const result = await runWorkflow(baseRequest, {
      ...defaultActivities,
      evaluatePolicyActivity: async () => false,
    });

    expect(result.status).toBe('denied');
    expect(result.message).toContain('denied');
  });

  // ── 3. クォータ超過 ──────────────────────────────────────────────────────

  it('クォータ超過: quota-exceeded を返すこと', async () => {
    const result = await runWorkflow(baseRequest, {
      ...defaultActivities,
      checkQuotaActivity: async () => ({ allowed: false, current: 100, limit: 100 }),
    });

    expect(result.status).toBe('quota-exceeded');
    expect(result.message).toContain('Quota exceeded');
  });

  // ── 4. 業務処理失敗 + Saga 補償 ──────────────────────────────────────────

  it('業務処理失敗 (create): compensateRequestActivity が呼ばれて error を返すこと', async () => {
    const compensateSpy = vi.fn().mockResolvedValue('File compensation completed: id=wf-test-001');
    const persistSpy    = vi.fn().mockResolvedValue(undefined);

    const result = await runWorkflow(baseRequest, {
      ...defaultActivities,
      processRequestActivity:   async () => { throw new Error('FileStorageService POST: HTTP 503'); },
      compensateRequestActivity: compensateSpy,
      persistRequestActivity:   persistSpy,
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('Workflow failed');

    // 補償が呼ばれたこと
    expect(compensateSpy).toHaveBeenCalledOnce();
    const compensateArg = compensateSpy.mock.calls[0]?.[0] as PlatformRequest;
    expect(compensateArg.requestId).toBe('wf-test-001');

    // failed でステータスが永続化されたこと
    const lastPersistCall = persistSpy.mock.calls.at(-1) as unknown[];
    expect(lastPersistCall?.[1]).toBe('failed');
  });

  it('業務処理失敗 (read): compensateRequestActivity が呼ばれないこと', async () => {
    const compensateSpy = vi.fn().mockResolvedValue('No compensation registered');

    const readRequest: PlatformRequest = { ...baseRequest, action: 'read' };

    const result = await runWorkflow(readRequest, {
      ...defaultActivities,
      processRequestActivity:    async () => { throw new Error('FileStorageService GET: HTTP 503'); },
      compensateRequestActivity: compensateSpy,
    });

    expect(result.status).toBe('error');
    // read は補償不要 → compensate が呼ばれないこと
    expect(compensateSpy).not.toHaveBeenCalled();
  });

  // ── 5. キャンセルシグナル ─────────────────────────────────────────────────

  it('処理中キャンセル: failed を返すこと', async () => {
    let resolveProcess!: () => void;
    const processPromise = new Promise<string>(resolve => {
      resolveProcess = () => resolve('done');
    });

    const worker = await Worker.create({
      connection:    testEnv.nativeConnection,
      taskQueue:     'test-queue-cancel',
      workflowsPath: fileURLToPath(new URL('../../workflows/platformWorkflow.ts', import.meta.url)),
      activities: {
        ...defaultActivities,
        processRequestActivity: async () => {
          // シグナルが届くまで待機してからキャンセルを処理させる
          await processPromise;
          return 'done';
        },
      },
    });

    const wfId = `test-cancel-${Date.now()}`;

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(platformWorkflow, {
        taskQueue:  'test-queue-cancel',
        workflowId: wfId,
        args:       [baseRequest],
      });

      // 少し待ってからキャンセルシグナルを送信
      await testEnv.sleep('100ms');
      await handle.signal(cancelSignal);
      resolveProcess();

      return handle.result();
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('Cancelled');
  }, 15_000);
});
