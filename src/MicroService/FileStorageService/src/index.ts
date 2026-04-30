import express from 'express';
import cors from 'cors';
import filesRouter from './routes/files';

const app = express();
const PORT = Number(process.env.PORT ?? 4001);

app.use(cors());
app.use(express.json());
app.use('/api/files', filesRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'file-storage-service' });
});

app.listen(PORT, () => {
  console.log(`[FileStorageService] listening on :${PORT}`);
});
