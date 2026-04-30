import loadPolicy from './loadPolicy.ts';
import { evaluateAllow } from './opa.ts';

async function main(): Promise<void> {
  await loadPolicy();

  const res1 = await evaluateAllow({ user: 'alice', action: 'read' });
  console.log('alice/read ->', res1);

  const res2 = await evaluateAllow({ user: 'bob', action: 'read' });
  console.log('bob/read ->', res2);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
