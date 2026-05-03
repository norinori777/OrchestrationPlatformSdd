import { Router, Request, Response } from 'express';
import * as yup from 'yup';
import { classifyFile, getRoutingRequest } from '../services/routing';

const router = Router();

const classifySchema = yup.object({
  filePath:     yup.string().required(),
  originalName: yup.string().required(),
  mimeType:     yup.string().required(),
  size:         yup.number().integer().positive().optional(),
});

// POST /api/routing/classify
router.post('/classify', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = await classifySchema.validate(req.body, { abortEarly: false });
    const result = await classifyFile(body);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof yup.ValidationError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('Unsupported file type') ||
      message.includes('File not found')
    ) {
      res.status(422).json({ error: message });
      return;
    }
    console.error('[RoutingFileService] classify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/routing/:id
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const record = await getRoutingRequest(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    res.json(record);
  } catch (err) {
    console.error('[RoutingFileService] get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
