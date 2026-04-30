import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as yup from 'yup';
import { publishEvent } from '../natsClient';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

const createFileSchema = yup.object({
  tenantId:    yup.string().required(),
  userId:      yup.string().required(),
  filename:    yup.string().required(),
  storagePath: yup.string().required(),
  size:        yup.number().optional(),
  contentType: yup.string().optional(),
});

// POST /api/files — ファイル保管イベントを発行
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = await createFileSchema.validate(req.body, { abortEarly: false });
    const requestId = `req-file-${uuidv4()}`;

    await prisma.saasRequest.create({
      data: {
        id:       requestId,
        tenantId: body.tenantId,
        userId:   body.userId,
        action:   'create',
        resource: 'files',
        status:   'pending',
        payload:  body,
      },
    });

    publishEvent('platform.events.files', {
      requestId,
      tenantId:  body.tenantId,
      userId:    body.userId,
      action:    'create',
      resource:  'files',
      payload: {
        filename:    body.filename,
        storagePath: body.storagePath,
        size:        body.size,
        contentType: body.contentType,
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

// GET /api/files/:requestId — リクエスト状態確認
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

// DELETE /api/files/:fileId — ファイル削除イベントを発行
router.delete('/:fileId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { tenantId, userId } = req.body as { tenantId?: string; userId?: string };
    if (!tenantId || !userId) {
      res.status(400).json({ error: 'tenantId and userId are required in request body' });
      return;
    }
    const requestId = `req-file-del-${uuidv4()}`;

    await prisma.saasRequest.create({
      data: {
        id:       requestId,
        tenantId,
        userId,
        action:   'delete',
        resource: 'files',
        status:   'pending',
        payload:  { fileId: req.params.fileId },
      },
    });

    publishEvent('platform.events.files', {
      requestId,
      tenantId,
      userId,
      action:   'delete',
      resource: 'files',
      payload:  { fileId: req.params.fileId },
    });

    res.status(202).json({ requestId, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
