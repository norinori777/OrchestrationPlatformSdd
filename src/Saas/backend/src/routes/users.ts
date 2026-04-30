import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as yup from 'yup';
import { publishEvent } from '../natsClient';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

const createUserSchema = yup.object({
  tenantId: yup.string().required(),
  userId:   yup.string().required(),
  email:    yup.string().email().required(),
  name:     yup.string().required(),
  role:     yup.string().oneOf(['admin', 'operator', 'viewer']).default('viewer'),
});

// POST /api/users — ユーザー作成イベントを発行
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = await createUserSchema.validate(req.body, { abortEarly: false });
    const requestId = `req-user-${uuidv4()}`;

    await prisma.saasRequest.create({
      data: {
        id:       requestId,
        tenantId: body.tenantId,
        userId:   body.userId,
        action:   'create',
        resource: 'users',
        status:   'pending',
        payload:  body,
      },
    });

    publishEvent('platform.events.users', {
      requestId,
      tenantId:  body.tenantId,
      userId:    body.userId,
      action:    'create',
      resource:  'users',
      payload: {
        email: body.email,
        name:  body.name,
        role:  body.role,
      },
    });

    res.status(202).json({ requestId, status: 'pending' });
  } catch (err) {
    if (err instanceof yup.ValidationError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users/:requestId — リクエスト状態確認
router.get('/:requestId', async (req: Request, res: Response): Promise<void> => {
  try {
    const record = await prisma.saasRequest.findUnique({
      where: { id: req.params.requestId },
    });
    if (!record) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/users/:targetUserId — ユーザー削除イベントを発行
router.delete('/:targetUserId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { tenantId, userId } = req.body as { tenantId?: string; userId?: string };
    if (!tenantId || !userId) {
      res.status(400).json({ error: 'tenantId and userId are required in request body' });
      return;
    }
    const requestId = `req-user-del-${uuidv4()}`;

    await prisma.saasRequest.create({
      data: {
        id:       requestId,
        tenantId,
        userId,
        action:   'delete',
        resource: 'users',
        status:   'pending',
        payload:  { targetUserId: req.params.targetUserId },
      },
    });

    publishEvent('platform.events.users', {
      requestId,
      tenantId,
      userId,
      action:   'delete',
      resource: 'users',
      payload:  { userId: req.params.targetUserId },
    });

    res.status(202).json({ requestId, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
