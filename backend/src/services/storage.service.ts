import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';

/**
 * StorageService abstracts where uploaded files physically live.
 * Today it writes to local disk (storage/uploads). To move to S3/GCS/etc.
 * later, implement the same interface (save/getAbsolutePath/exists/delete)
 * backed by an object-storage SDK and swap the export below.
 */
export interface StorageService {
  save(buffer: Buffer, originalFilename: string, mimeType: string): Promise<{ storagePath: string; absolutePath: string }>;
  getAbsolutePath(storagePath: string): string;
  exists(storagePath: string): boolean;
  delete(storagePath: string): Promise<void>;
}

function sanitizeExtension(originalFilename: string, mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  if (mimeToExt[mimeType]) return mimeToExt[mimeType];

  const ext = path.extname(originalFilename).toLowerCase();
  const safeExt = /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : '.bin';
  return safeExt;
}

class LocalStorageService implements StorageService {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }
  }

  async save(
    buffer: Buffer,
    originalFilename: string,
    mimeType: string
  ): Promise<{ storagePath: string; absolutePath: string }> {
    const ext = sanitizeExtension(originalFilename, mimeType);
    // Never trust the original filename - always generate a unique name.
    const generatedName = `${uuidv4()}${ext}`;
    const absolutePath = path.join(this.rootDir, generatedName);

    // Defense-in-depth: ensure the resolved path stays within rootDir.
    const resolved = path.resolve(absolutePath);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error('Path traversal detected in storage path resolution');
    }

    await fs.promises.writeFile(resolved, buffer);
    return { storagePath: generatedName, absolutePath: resolved };
  }

  getAbsolutePath(storagePath: string): string {
    const resolved = path.resolve(this.rootDir, storagePath);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  exists(storagePath: string): boolean {
    try {
      return fs.existsSync(this.getAbsolutePath(storagePath));
    } catch {
      return false;
    }
  }

  async delete(storagePath: string): Promise<void> {
    const absolutePath = this.getAbsolutePath(storagePath);
    if (fs.existsSync(absolutePath)) {
      await fs.promises.unlink(absolutePath);
    }
  }
}

export const storageService: StorageService = new LocalStorageService(env.storage.uploadDir);
