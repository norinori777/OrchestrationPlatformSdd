// ─────────────────────────────────────────────────────────────────────────────
// Temporal ワーカー
// ・NativeConnection でネイティブ gRPC 接続 (本番推奨)
// ・graceful shutdown は index.ts の AbortController 経由で制御
// ─────────────────────────────────────────────────────────────────────────────
import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'url';
import type Redis from 'ioredis';
import type { NatsConnection } from 'nats';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { createActivities } from './activities/index.ts';

export async function startWorker(
  config: Config,
  logger: Logger,
  redis: Redis,
  nc: NatsConnection,
): Promise<Worker> {
  const log = logger.child({ component: 'worker' });

  const connection = await NativeConnection.connect({
    address: config.temporal.address,
  });

  const activities   = createActivities(config, logger, redis, nc);
  const workflowsPath = fileURLToPath(
    new URL('./workflows/platformWorkflow.ts', import.meta.url),
  );

  const worker = await Worker.create({
    connection,
    namespace:    config.temporal.namespace,
    taskQueue:    config.temporal.taskQueue,
    workflowsPath,
    activities,
    // 実運用チューニング例:
    // maxConcurrentActivityTaskExecutions: 100,
    // maxConcurrentWorkflowTaskExecutions: 40,
  });

  log.info('Worker created', {
    address:   config.temporal.address,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
  });

  return worker;
}
