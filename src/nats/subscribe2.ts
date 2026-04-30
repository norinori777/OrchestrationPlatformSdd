import { connect, StringCodec } from 'nats';
import { Connection, WorkflowClient } from '@temporalio/client';
import { helloWorkflow2 } from '../gPRC/workflows.ts';

async function main(): Promise<void> {
	const nc = await connect({ servers: 'localhost:4222' });
	const sc = StringCodec();
	const connection = await Connection.connect({ address: 'localhost:7233' });
	const client = new WorkflowClient({ connection });

	console.log('subscribed on demo, waiting message...');
	const sub = nc.subscribe('demo');

	for await (const message of sub) {
		const payload = sc.decode(message.data);
		const input = JSON.parse(payload) as { user: string; action: string };
		const workflowId = `demo-${Date.now()}`;
		console.log('received:', payload);

		const handle = await client.start(helloWorkflow2, {
			args: [input],
			taskQueue: 'demo-task-queue',
			workflowId,
		});

		console.log('started workflow:', handle.workflowId);
		console.log('result:', await handle.result());
	}

	await nc.close();
	await connection.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});