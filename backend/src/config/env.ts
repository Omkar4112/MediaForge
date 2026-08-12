import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  postgres: {
    host: required('POSTGRES_HOST', 'localhost'),
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: required('POSTGRES_USER', 'mediaforge'),
    password: required('POSTGRES_PASSWORD', 'mediaforge'),
    database: required('POSTGRES_DB', 'mediaforge_media'),
  },

  redis: {
    host: required('REDIS_HOST', 'localhost'),
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  analyzer: {
    baseUrl: required('ANALYZER_BASE_URL', 'http://localhost:8000'),
    timeoutMs: parseInt(process.env.ANALYZER_TIMEOUT_MS || '60000', 10),
  },

  storage: {
    uploadDir: process.env.STORAGE_UPLOAD_DIR
      ? path.resolve(process.env.STORAGE_UPLOAD_DIR)
      : path.resolve(__dirname, '../../../storage/uploads'),
  },

  upload: {
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || `${10 * 1024 * 1024}`, 10), // 10MB
    allowedMimeTypes: (process.env.ALLOWED_MIME_TYPES || 'image/jpeg,image/png,image/webp').split(','),
  },

  queue: {
    name: process.env.QUEUE_NAME || 'image-processing',
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '2', 10),
    maxAttempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10),
  },

  duplicate: {
    hammingThreshold: parseInt(process.env.DUPLICATE_HAMMING_THRESHOLD || '8', 10),
  },
};
