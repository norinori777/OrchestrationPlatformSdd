import fs from 'fs/promises';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

async function loadPolicy(): Promise<void> {
  const policy = await fs.readFile(new URL('./policy.rego', import.meta.url), 'utf8');
  const res = await fetch('http://localhost:8181/v1/policies/example', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: policy,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upload policy: ${res.status} ${res.statusText} - ${text}`);
  }

  console.log('Policy uploaded: example');
}

export default loadPolicy;

// Allow direct run via ts-node
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  loadPolicy().catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });
}
