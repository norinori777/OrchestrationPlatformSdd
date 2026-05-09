import * as fs from 'fs';
import * as path from 'path';

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log']);
const MAX_CHUNK_TOKENS = Number(process.env.MAX_CHUNK_TOKENS ?? 2000);
const CHUNK_OVERLAP_TOKENS = 100;
// 日本語混在を考慮した大まかなトークン換算 (1トークン ≈ 3.5文字)
const CHARS_PER_TOKEN = 3.5;

export interface FileChunk {
  index: number;
  content: string;
}

export function validateExtension(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`
    );
  }
}

export function readFileContent(filePath: string, fallbackContent?: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    if (fallbackContent !== undefined) {
      return fallbackContent;
    }
    throw new Error(
      `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`
    );
  }

  if (!fs.existsSync(filePath)) {
    if (fallbackContent !== undefined) {
      return fallbackContent;
    }
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export function splitIntoChunks(content: string): FileChunk[] {
  const maxChars = Math.floor(MAX_CHUNK_TOKENS * CHARS_PER_TOKEN);
  const overlapChars = Math.floor(CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN);

  if (content.length <= maxChars) {
    return [{ index: 0, content }];
  }

  const chunks: FileChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < content.length) {
    const end = Math.min(start + maxChars, content.length);
    chunks.push({ index, content: content.slice(start, end) });
    start = end - overlapChars;
    index++;
  }

  return chunks;
}

export function readAndChunk(filePath: string, fallbackContent?: string): FileChunk[] {
  const content = readFileContent(filePath, fallbackContent);
  return splitIntoChunks(content);
}
