import express from 'express';
import cors from 'cors';
import routingRouter from './routes/files';
import { prisma } from './db';

const app = express();
const PORT = Number(process.env.PORT ?? 4003);

app.use(cors());
app.use(express.json());

app.use('/api/routing', routingRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'routing-file-service' });
});

const server = app.listen(PORT, () => {
  console.log(`[RoutingFileService] listening on :${PORT}`);
});

async function shutdown(): Promise<void> {
  console.log('[RoutingFileService] shutting down...');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
