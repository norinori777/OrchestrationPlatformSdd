// ─────────────────────────────────────────────────────────────────────────────
// OPA へポリシーとデータをロードするスクリプト
//
// 実行:
//   npx ts-node src/product/policies/loadPolicy.ts
//
// 環境変数:
//   OPA_BASE_URL (デフォルト: http://localhost:8181)
// ─────────────────────────────────────────────────────────────────────────────
import fetch from 'node-fetch';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPA_BASE  = process.env.OPA_BASE_URL ?? 'http://localhost:8181';

async function put(url: string, body: string, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method:  'PUT',
    headers: { 'Content-Type': contentType },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${url} failed [${res.status}]: ${text}`);
  }
}

async function main(): Promise<void> {
  console.log(`Loading platform policy to OPA at ${OPA_BASE}…`);

  // ── 1. Rego ポリシーをロード ─────────────────────────────────────────
  const regoText = await readFile(path.join(__dirname, 'platform.rego'), 'utf-8');
  await put(`${OPA_BASE}/v1/policies/platform`, regoText, 'text/plain');
  console.log('✔  Policy loaded: platform/authz');

  // ── 2. RBAC データをロード ────────────────────────────────────────────
  // PUT /v1/data/platform → data.platform.* として OPA 内に保存される
  const dataText = await readFile(path.join(__dirname, 'platform-data.json'), 'utf-8');
  await put(`${OPA_BASE}/v1/data/platform`, dataText, 'application/json');
  console.log('✔  RBAC data loaded: data.platform');

  // ── 3. 疎通確認 ───────────────────────────────────────────────────────
  console.log('\nRunning smoke tests…');

  type OpaResult = { result?: boolean };

  async function query(input: Record<string, string>): Promise<boolean> {
    const res = await fetch(`${OPA_BASE}/v1/data/platform/authz/allow`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ input }),
    });
    const json = (await res.json()) as OpaResult;
    return Boolean(json.result);
  }

  const cases: Array<[Record<string, string>, boolean]> = [
    // orders
    [{ tenantId: 'tenant-a', userId: 'alice',       action: 'create', resource: 'orders' }, true],
    [{ tenantId: 'tenant-a', userId: 'bob',         action: 'read',   resource: 'orders' }, true],
    [{ tenantId: 'tenant-a', userId: 'bob',         action: 'delete', resource: 'orders' }, false],
    [{ tenantId: 'tenant-b', userId: 'charlie',     action: 'read',   resource: 'orders' }, true],
    [{ tenantId: 'tenant-b', userId: 'charlie',     action: 'create', resource: 'orders' }, false],
    [{ tenantId: 'tenant-a', userId: 'super-admin', action: 'delete', resource: 'users'  }, true],
    // files — admin (alice@tenant-a) は read/create/delete 可
    [{ tenantId: 'tenant-a', userId: 'alice',       action: 'create', resource: 'files'  }, true],
    [{ tenantId: 'tenant-a', userId: 'alice',       action: 'read',   resource: 'files'  }, true],
    [{ tenantId: 'tenant-a', userId: 'alice',       action: 'delete', resource: 'files'  }, true],
    // files — operator (bob@tenant-b) は read/create 可、delete 不可
    [{ tenantId: 'tenant-b', userId: 'bob',         action: 'read',   resource: 'files'  }, true],
    [{ tenantId: 'tenant-b', userId: 'bob',         action: 'create', resource: 'files'  }, true],
    [{ tenantId: 'tenant-b', userId: 'bob',         action: 'delete', resource: 'files'  }, false],
    // files — viewer (charlie@tenant-b) は read 可、create/delete 不可
    [{ tenantId: 'tenant-b', userId: 'charlie',     action: 'read',   resource: 'files'  }, true],
    [{ tenantId: 'tenant-b', userId: 'charlie',     action: 'create', resource: 'files'  }, false],
    [{ tenantId: 'tenant-b', userId: 'charlie',     action: 'delete', resource: 'files'  }, false],
  ];

  let passed = 0;
  for (const [input, expected] of cases) {
    const actual = await query(input);
    const ok     = actual === expected;
    const mark   = ok ? '✔' : '✘';
    console.log(
      `  ${mark}  ${input.userId}@${input.tenantId} ${input.action}:${input.resource}` +
      ` → ${actual} (expected ${expected})`,
    );
    if (ok) passed++;
  }

  console.log(`\n${passed}/${cases.length} tests passed`);
  if (passed < cases.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
