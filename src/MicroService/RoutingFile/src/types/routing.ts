export type FileCategory =
  | 'invoice'
  | 'contract'
  | 'report'
  | 'email'
  | 'form'
  | 'other';

export type RequestStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ClassifyRequest {
  filePath: string;
  originalName: string;
  mimeType: string;
  size?: number;
}

export interface ChunkResult {
  chunkIndex: number;
  category: FileCategory;
  confidence: number;
  reason: string;
}

export interface ClassificationResult {
  category: FileCategory;
  confidence: number;
  reason: string;
  model: string;
  promptVersion: string;
  chunkResults: ChunkResult[];
}

export interface ClassifyResponse {
  id: string;
  filePath: string;
  mimeType: string;
  status: RequestStatus;
  category: FileCategory | null;
  confidence: number | null;
  reason: string | null;
  classifiedAt: Date;
}
