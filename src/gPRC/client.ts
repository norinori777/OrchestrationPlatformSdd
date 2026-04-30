import { Connection, WorkflowClient } from '@temporalio/client';
import { helloWorkflow } from './workflows.ts';

    async function run() {
    const connection = await Connection.connect({ address: 'localhost:7233' });
    const client = new WorkflowClient({ connection });
    const handle = await client.start(helloWorkflow, {
        args: ['world'],
        taskQueue: 'demo-task-queue',
        workflowId: `demo-${Date.now()}`,
    });
    console.log('Started workflow:', handle.workflowId);
    console.log('Result:', await handle.result());
    }

    run().catch((err) => { console.error(err); process.exit(1); });