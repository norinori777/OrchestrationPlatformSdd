import * as fs from 'fs';
import * as path from 'path';

interface FileStorageConfig {
  storageRoot: string;
}

const CONFIG_PATH = path.resolve(process.cwd(), '../../../config/file-storage.json');

function loadFileStorageConfig(): FileStorageConfig {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<FileStorageConfig>;

  if (!parsed.storageRoot || typeof parsed.storageRoot !== 'string') {
    throw new Error(`Invalid file storage config: ${CONFIG_PATH}`);
  }

  return { storageRoot: parsed.storageRoot };
}

const config = loadFileStorageConfig();

export const STORAGE_ROOT = path.resolve(process.cwd(), '../../../', config.storageRoot);