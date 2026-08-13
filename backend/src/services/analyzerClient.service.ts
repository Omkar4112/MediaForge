import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export type CheckStatus = 'pass' | 'warning' | 'fail' | 'not_applicable';

export interface AnalyzerCheckResult {
  status: CheckStatus;
  score?: number | null;
  [key: string]: unknown;
}

export interface AnalyzerResponse {
  blur: AnalyzerCheckResult;
  brightness: AnalyzerCheckResult;
  ocr: AnalyzerCheckResult;
  numberPlate: AnalyzerCheckResult;
  dimensions: AnalyzerCheckResult;
  photoOfPhoto: AnalyzerCheckResult;
  tampering: AnalyzerCheckResult;
  phash: string;
}

const client = axios.create({
  baseURL: env.analyzer.baseUrl,
  timeout: env.analyzer.timeoutMs,
});

export async function wakeAnalyzer(): Promise<void> {
  const healthUrl = `${env.analyzer.baseUrl}/health`;
  const maxAttempts = 15;
  const delayMs = 5000;

  logger.info('Analyzer wake-up process started...', { url: healthUrl });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.get<{ status: string }>('/health', {
        timeout: 10000,
      });

      if (response.status === 200 && response.data?.status === 'ok') {
        logger.info('Analyzer is ready and healthy.', { attempt });
        return;
      }

      logger.warn(`Analyzer health checked, status ${response.status} but response is not "ok"`, {
        data: response.data,
        attempt,
      });
    } catch (err: any) {
      const status = err.response?.status;
      const code = err.code;
      const isTransient =
        !err.response ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNRESET' ||
        err.message?.toLowerCase().includes('timeout');

      if (isTransient) {
        logger.info(`Analyzer is still unavailable / waking up (attempt ${attempt}/${maxAttempts})...`, {
          error: err.message,
          code,
          status,
        });
      } else {
        logger.error('Non-transient error during analyzer wake-up check', {
          error: err.message,
          code,
          status,
        });
        throw err;
      }
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  logger.error('Analyzer wake-up failed: maximum retry attempts exhausted');
  throw new Error('Analyzer failed to wake up after maximum retry attempts');
}

export async function analyzeImage(
  absoluteFilePath: string,
  mimeType: string,
  imageType?: string
): Promise<AnalyzerResponse> {
  // 1. Ensure the analyzer is awake and healthy
  await wakeAnalyzer();

  // 2. Perform the actual POST request
  const url = `${env.analyzer.baseUrl}/analyze`;
  logger.info('Sending POST request to analyzer', {
    url,
    mimeType,
    imageType,
    filePath: absoluteFilePath,
  });

  const fileBuffer = fs.readFileSync(absoluteFilePath);
  const maxAttempts = 3;
  const delayMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const form = new FormData();
      form.append('file', fileBuffer, {
        filename: path.basename(absoluteFilePath),
        contentType: mimeType,
      });
      if (imageType) {
        form.append('image_type', imageType);
      }

      const contentLength = form.getLengthSync();
      const headers = {
        ...form.getHeaders(),
        'Content-Length': contentLength,
      };

      const response = await client.post<AnalyzerResponse>('/analyze', form, {
        headers,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      logger.info('Received response from analyzer', {
        url,
        status: response.status,
        statusText: response.statusText,
        data: response.data,
      });

      return response.data;
    } catch (err: any) {
      const status = err.response?.status;
      const code = err.code;
      const isTransient =
        !err.response ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNRESET' ||
        err.message?.toLowerCase().includes('timeout');

      if (isTransient && attempt < maxAttempts) {
        logger.warn(`Analyzer analyze request failed transiently (attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs / 1000}s...`, {
          error: err.message,
          code,
          status,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const errorDetails = {
        url,
        message: err.message,
        status,
        statusText: err.response?.statusText,
        responseData: err.response?.data,
      };
      logger.error('Analyzer request failed permanently', errorDetails);
      throw err;
    }
  }
  throw new Error('Analyzer request failed after maximum retry attempts');
}


