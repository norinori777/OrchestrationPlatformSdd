import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'url';
import { evaluateAllow } from '../Opa/opa.ts';

async function run() {
    const workflowsPath = fileURLToPath(new URL('./workflows.ts', import.meta.url));
    const worker = await Worker.create({
        workflowsPath,
        taskQueue: 'demo-task-queue',
        activities: {
            evaluateAllow,
        },
    });
    await worker.run();
    }

run().catch((err) => { console.error(err); process.exit(1); });