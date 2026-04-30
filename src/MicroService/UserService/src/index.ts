import express from 'express';
import cors from 'cors';
import usersRouter from './routes/users';

const app = express();
const PORT = Number(process.env.PORT ?? 4002);

app.use(cors());
app.use(express.json());
app.use('/api/users', usersRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'user-service' });
});

app.listen(PORT, () => {
  console.log(`[UserService] listening on :${PORT}`);
});
