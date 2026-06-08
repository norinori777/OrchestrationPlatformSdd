import express from 'express';
import cors from 'cors';
// use express.json() for JSON parsing
import { PrismaClient } from '../../../node_modules/.prisma/product-client/index.js';
import { validateOrchestrationDefinition } from '../orchestrations/validateOrchestration.ts';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.ADMIN_API_JWT_SECRET ?? 'dev-secret';
const ADMIN_USER = process.env.ADMIN_API_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_API_PASSWORD ?? 'password';

function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers['authorization'] as string | undefined;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const prisma = new PrismaClient();

app.get('/orchestrations', requireAuth, async (req, res) => {
  const page = Number(req.query.page ?? 0);
  const perPage = Number(req.query.perPage ?? 10);
  const take = Math.max(1, perPage);
  const skip = Math.max(0, page) * take;
  const [items, total] = await Promise.all([
    prisma.orchestrationDefinition.findMany({ select: { id: true, title: true, description: true, enabled: true }, skip, take, orderBy: { id: 'asc' } }),
    prisma.orchestrationDefinition.count(),
  ]);
  res.json({ total, items });
});

app.get('/orchestrations/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const row = await prisma.orchestrationDefinition.findUnique({ where: { id } });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ sub: username, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token });
  }
  return res.status(401).json({ error: 'invalid credentials' });
});

app.post('/orchestrations/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { title, description, definition, enabled } = req.body;
  const valid = validateOrchestrationDefinition(definition);
  if (!valid.valid) return res.status(400).json({ error: 'invalid definition', details: valid.errors });
  // upsert definition
  const up = await prisma.orchestrationDefinition.upsert({
    where: { id },
    update: { title: title ?? id, description: description ?? '', definition: definition as any, enabled: enabled ?? true, updatedAt: new Date() },
    create: { id, title: title ?? id, description: description ?? '', definition: definition as any, enabled: enabled ?? true },
  });
  // create a new version entry
  const maxVer = await prisma.orchestrationVersion.findMany({ where: { orchestrationId: id }, orderBy: { version: 'desc' }, take: 1 });
  const nextVersion = (maxVer[0]?.version ?? 0) + 1;
  await prisma.orchestrationVersion.create({ data: { orchestrationId: id, version: nextVersion, definition: definition as any, createdBy: ((req as any).user && (req as any).user.sub) ?? null } });
  res.json(up);
});

app.delete('/orchestrations/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    await prisma.orchestrationDefinition.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    res.status(404).json({ error: 'not found' });
  }
});

// Versions
app.get('/orchestrations/:id/versions', requireAuth, async (req, res) => {
  const id = req.params.id;
  const rows = await prisma.orchestrationVersion.findMany({ where: { orchestrationId: id }, orderBy: { version: 'desc' } });
  res.json(rows.map(r => ({ id: r.id, version: r.version, createdAt: r.createdAt, createdBy: r.createdBy })));
});

app.get('/orchestrations/:id/versions/:vid', requireAuth, async (req, res) => {
  const vid = req.params.vid;
  const row = await prisma.orchestrationVersion.findUnique({ where: { id: vid } });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.post('/orchestrations/:id/restore/:vid', requireAuth, async (req, res) => {
  const id = req.params.id;
  const vid = req.params.vid;
  const row = await prisma.orchestrationVersion.findUnique({ where: { id: vid } });
  if (!row || row.orchestrationId !== id) return res.status(404).json({ error: 'version not found' });
  // restore: upsert definition with the version's definition
  const up = await prisma.orchestrationDefinition.upsert({ where: { id }, update: { definition: row.definition as any, updatedAt: new Date() }, create: { id, title: id, description: '', definition: row.definition as any, enabled: true } });
  // create a new version entry for the restore action
  const maxVer = await prisma.orchestrationVersion.findMany({ where: { orchestrationId: id }, orderBy: { version: 'desc' }, take: 1 });
  const nextVersion = (maxVer[0]?.version ?? 0) + 1;
  await prisma.orchestrationVersion.create({ data: { orchestrationId: id, version: nextVersion, definition: row.definition as any, createdBy: ((req as any).user && (req as any).user.sub) ?? null } });
  res.json(up);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const port = process.env.ADMIN_PORT ? Number(process.env.ADMIN_PORT) : 4006;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Orchestration admin API listening on http://localhost:${port}`);
});
