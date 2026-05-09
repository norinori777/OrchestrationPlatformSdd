import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as yup from 'yup';
import { prisma } from '../db';
import { STORAGE_ROOT } from '../config';

const router = Router();

const createSchema = yup.object({
  id:          yup.string().required(),
  tenantId:    yup.string().required(),
  userId:      yup.string().required(),
  filename:    yup.string().required(),
  storagePath: yup.string().required(),
  size:        yup.number().nullable().optional(),
  contentType: yup.string().nullable().optional(),
  fileContentBase64: yup.string().required(),
});

function resolveStoragePath(relativeStoragePath: string): string {
  const normalized = relativeStoragePath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(STORAGE_ROOT, normalized);
  const rootWithSeparator = `${STORAGE_ROOT}${path.sep}`;

  if (resolved !== STORAGE_ROOT && !resolved.startsWith(rootWithSeparator)) {
    throw new Error(`Invalid storage path: ${relativeStoragePath}`);
  }

  return resolved;
}

// POST /api/files
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = await createSchema.validate(req.body, { abortEarly: false });
    const storagePath = resolveStoragePath(body.storagePath);
    const fileBuffer = Buffer.from(body.fileContentBase64, 'base64');

    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, fileBuffer);

    // upsert で冪等性を確保 (Temporal リトライ時に同一 id が再送されても安全)
    const file = await prisma.file.upsert({
      where: { id: body.id },
      create: {
        id:          body.id,
        tenantId:    body.tenantId,
        userId:      body.userId,
        filename:    body.filename,
        storagePath,
        size:        body.size ?? null,
        contentType: body.contentType ?? null,
      },
      update: {},  // 既存レコードは変更しない
    });
    res.status(201).json(file);
  } catch (err) {
    if (err instanceof yup.ValidationError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files/:id
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const file = await prisma.file.findUnique({ where: { id: req.params.id } });
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/files/:id
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    const file = await prisma.file.findUnique({ where: { id: req.params.id } });
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    if (tenantId && file.tenantId !== tenantId) {
      res.status(403).json({ error: 'Forbidden: tenant mismatch' });
      return;
    }
    await prisma.file.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
