import { Router, Request, Response } from 'express';
import * as yup from 'yup';
import { prisma } from '../db';

const router = Router();

const createSchema = yup.object({
  id:       yup.string().required(),
  tenantId: yup.string().required(),
  email:    yup.string().email().required(),
  name:     yup.string().required(),
  role:     yup.string().oneOf(['admin', 'operator', 'viewer']).default('viewer'),
});

// POST /api/users
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = await createSchema.validate(req.body, { abortEarly: false });
    // upsert で冪等性を確保 (Temporal リトライ時に同一 id が再送されても安全)
    const user = await prisma.serviceUser.upsert({
      where: { id: body.id },
      create: {
        id:       body.id,
        tenantId: body.tenantId,
        email:    body.email,
        name:     body.name,
        role:     body.role ?? 'viewer',
      },
      update: {},  // 既存レコードは変更しない
    });
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof yup.ValidationError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    // P2002: tenantId + email のユニーク制約違反
    if ((err as any)?.code === 'P2002') {
      res.status(409).json({ error: 'User with this email already exists in the tenant' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users/:id
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.serviceUser.findUnique({ where: { id: req.params.id } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    const user = await prisma.serviceUser.findUnique({ where: { id: req.params.id } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (tenantId && user.tenantId !== tenantId) {
      res.status(403).json({ error: 'Forbidden: tenant mismatch' });
      return;
    }
    await prisma.serviceUser.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
