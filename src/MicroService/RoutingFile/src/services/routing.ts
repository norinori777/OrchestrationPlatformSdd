import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../db';
import { readAndChunk } from './fileReader';
import { classifyChunk, aggregateChunkResults } from './classifier';
import { ClassifyRequest, ClassifyResponse, FileCategory } from '../types/routing';

const MAX_CHUNKS = Number(process.env.MAX_CHUNKS_PER_FILE ?? 10);

export async function classifyFile(req: ClassifyRequest): Promise<ClassifyResponse> {
  const id = uuidv4();

  // DBにペンディングレコードを作成
  await prisma.routingRequest.create({
    data: {
      id,
      filePath:     req.filePath,
      originalName: req.originalName,
      mimeType:     req.mimeType,
      size:         req.size ?? null,
      status:       'processing',
    },
  });

  try {
    // ファイル読み込み & チャンク分割
    const chunks = readAndChunk(req.filePath);
    const limitedChunks = chunks.slice(0, MAX_CHUNKS);

    // 各チャンクを分類
    const chunkResults = await Promise.all(
      limitedChunks.map((chunk) => classifyChunk(chunk.content, chunk.index))
    );

    // チャンク結果を集約
    const aggregated = aggregateChunkResults(chunkResults);

    // DBを更新
    const updated = await prisma.routingRequest.update({
      where: { id },
      data: {
        status:        'completed',
        category:      aggregated.category,
        confidence:    aggregated.confidence,
        reason:        aggregated.reason,
        model:         aggregated.model,
        promptVersion: aggregated.promptVersion,
        chunkResults:  chunkResults as object[],
      },
    });

    return {
      id:            updated.id,
      filePath:      updated.filePath,
      mimeType:      updated.mimeType,
      status:        updated.status as 'completed',
      category:      updated.category as FileCategory | null,
      confidence:    updated.confidence,
      reason:        updated.reason,
      classifiedAt:  updated.updatedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.routingRequest.update({
      where: { id },
      data: { status: 'failed', errorMessage: message },
    });

    throw err;
  }
}

export async function getRoutingRequest(id: string): Promise<ClassifyResponse | null> {
  const record = await prisma.routingRequest.findUnique({ where: { id } });
  if (!record) return null;

  return {
    id:           record.id,
    filePath:     record.filePath,
    mimeType:     record.mimeType,
    status:       record.status as ClassifyResponse['status'],
    category:     record.category as ClassifyResponse['category'],
    confidence:   record.confidence,
    reason:       record.reason,
    classifiedAt: record.updatedAt,
  };
}
