import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

export type OpaInput = { user: string; action: string };

export async function evaluateAllow(input: OpaInput): Promise<boolean> {
	const res = await fetch('http://localhost:8181/v1/data/example/authz/allow', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ input }),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`OPA request failed: ${res.status} ${res.statusText} - ${text}`);
	}

	const json = (await res.json()) as { result?: unknown };
	return Boolean(json.result);
}

async function main(): Promise<void> {
	try {
		const allow = await evaluateAllow({ user: 'alice', action: 'read' });
		console.log({ result: allow });
	} catch (err: any) {
		console.error('Error evaluating OPA policy:', err.message ?? err);
		process.exitCode = 2;
	}
}

// Run when executed directly: `node` or `ts-node`
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
	void main();
}

