// プラットフォームからの状態コールバックを受け取るルーター
// PATCH /api/requests/:requestId/status  { status, result? }
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

const ALLOWED_STATUSES = ['pending', 'denied', 'completed', 'failed'] as const;
type AllowedStatus = typeof ALLOWED_STATUSES[number];

// PATCH /api/requests/:requestId/status
router.patch('/:requestId/status', async (req: Request, res: Response): Promise<void> => {
  const { requestId } = req.params;
  const { status, result } = req.body as { status?: string; result?: string };

  if (!status || !ALLOWED_STATUSES.includes(status as AllowedStatus)) {
    res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
    return;
  }

  try {
    const updated = await prisma.saasRequest.updateMany({
      where: { id: requestId },
      data: {
        status,
        ...(result !== undefined ? { result } : {}),
      },
    });

    if (updated.count === 0) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    res.json({ requestId, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
