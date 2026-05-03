import OpenAI from 'openai';
import { FileCategory, ChunkResult } from '../types/routing';

const PROMPT_VERSION = '1.0.0';
const DEFAULT_MODEL = 'gpt-4o-mini';

const CATEGORY_LIST: FileCategory[] = [
  'invoice',
  'contract',
  'report',
  'email',
  'form',
  'other',
];

const SYSTEM_PROMPT = `You are a document classification assistant.
Classify the given text excerpt into exactly one of the following categories:
${CATEGORY_LIST.join(', ')}

Respond ONLY with a JSON object in this exact format (no markdown, no extra text):
{
  "category": "<one of the categories above>",
  "confidence": <float between 0.0 and 1.0>,
  "reason": "<brief explanation in Japanese, max 100 chars>"
}`;

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export interface ChunkClassification {
  category: FileCategory;
  confidence: number;
  reason: string;
}

export async function classifyChunk(
  chunkContent: string,
  chunkIndex: number
): Promise<ChunkResult> {
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const client = getClient();

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: chunkContent.slice(0, 6000) }, // safety cap
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content ?? '{}';

  let parsed: Partial<ChunkClassification>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const category = CATEGORY_LIST.includes(parsed.category as FileCategory)
    ? (parsed.category as FileCategory)
    : 'other';
  const confidence =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  return { chunkIndex, category, confidence, reason };
}

export function aggregateChunkResults(results: ChunkResult[]): {
  category: FileCategory;
  confidence: number;
  reason: string;
  model: string;
  promptVersion: string;
} {
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  // カテゴリごとに信頼度の加重合計でスコアリング
  const scores: Record<string, number> = {};
  for (const r of results) {
    scores[r.category] = (scores[r.category] ?? 0) + r.confidence;
  }

  let bestCategory: FileCategory = 'other';
  let bestScore = -1;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat as FileCategory;
    }
  }

  const avgConfidence =
    results
      .filter((r) => r.category === bestCategory)
      .reduce((sum, r) => sum + r.confidence, 0) /
    Math.max(results.filter((r) => r.category === bestCategory).length, 1);

  const topReason =
    results.find((r) => r.category === bestCategory)?.reason ?? '';

  return {
    category: bestCategory,
    confidence: Math.round(avgConfidence * 100) / 100,
    reason: topReason,
    model,
    promptVersion: PROMPT_VERSION,
  };
}
