import express from 'express';
import cors from 'cors';
import { connectNats, drainNats } from './natsClient';
import filesRouter    from './routes/files';
import usersRouter    from './routes/users';
import requestsRouter from './routes/requests';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json());

app.use('/api/files',    filesRouter);
app.use('/api/users',    usersRouter);
app.use('/api/requests', requestsRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'saas-backend' });
});

async function main(): Promise<void> {
  await connectNats();
  const server = app.listen(PORT, () => {
    console.log(`[SaaS Backend] listening on :${PORT}`);
  });

  const shutdown = async (): Promise<void> => {
    console.log('[SaaS Backend] shutting down...');
    server.close();
    await drainNats();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('[SaaS Backend] startup failed:', err);
  process.exit(1);
});
