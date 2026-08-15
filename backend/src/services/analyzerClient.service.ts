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
  const maxAttempts = 30;
  const delayMs = 5000;
  let attempt429Count = 0;
  const max429Attempts = 5;

  logger.info('Waking analyzer: Checking health status', { url: healthUrl });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.get<{ status: string }>('/health', {
        timeout: 10000,
      });

      if (response.status === 200 && response.data?.status === 'ok') {
        logger.info('Analyzer ready: health check passed', { url: healthUrl, attempt });
        return;
      }

      logger.warn(`Analyzer health checked, status ${response.status} but response is not "ok"`, {
        data: response.data,
        attempt,
      });
    } catch (err: any) {
      const status = err.response?.status;
      const code = err.code;

      const method = err.config?.method?.toUpperCase() || 'GET';
      const requestUrl = err.config?.url
        ? (err.config.url.startsWith('http') ? err.config.url : `${env.analyzer.baseUrl}${err.config.url}`)
        : healthUrl;
      const responseStatus = status || 'No Response/Unknown';
      const responseBody = err.response?.data || err.message;

      // Determine which service generated it
      let sourceService = 'Unknown';
      if (status) {
        const isRender =
          err.response?.headers?.['server']?.toLowerCase().includes('render') ||
          err.response?.headers?.['via']?.toLowerCase().includes('render') ||
          (typeof responseBody === 'string' && responseBody.includes('Render'));
        sourceService = isRender ? 'Render Load Balancer' : 'FastAPI Analyzer Service';
      }

      logger.error('Analyzer wake-up health request failed', {
        url: requestUrl,
        method,
        status: responseStatus,
        body: responseBody,
        sourceService,
      });

      const is429 = status === 429;
      if (is429) {
        attempt429Count++;
        if (attempt429Count > max429Attempts) {
          logger.error('Final failure: Analyzer health check received HTTP 429 and exceeded maximum 429 retries', {
            attempt429Count,
            max429Attempts,
          });
          throw err;
        }
      }

      const isTransient =
        !err.response ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        is429 ||
        [
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ENOTFOUND',
          'ECONNRESET',
          'EHOSTUNREACH',
          'ENETUNREACH',
          'EPIPE',
        ].includes(code) ||
        err.message?.toLowerCase().includes('timeout');

      if (isTransient) {
        let currentDelay = delayMs;
        if (is429) {
          const retryAfterHeader = err.response?.headers?.['retry-after'];
          if (retryAfterHeader) {
            const seconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(seconds)) {
              currentDelay = seconds * 1000;
            } else {
              const dateMs = Date.parse(retryAfterHeader);
              if (!isNaN(dateMs)) {
                currentDelay = Math.max(0, dateMs - Date.now());
              }
            }
            logger.info(`Respecting Retry-After header: waiting ${currentDelay / 1000}s...`);
          } else {
            // controlled exponential backoff
            currentDelay = Math.min(30000, 2000 * Math.pow(2, attempt429Count));
            logger.info(`HTTP 429 with no Retry-After header. Using exponential backoff: waiting ${currentDelay / 1000}s...`);
          }
        } else {
          logger.info(`Analyzer unavailable (attempt ${attempt}/${maxAttempts}): ${err.message}. Retrying in ${currentDelay / 1000}s...`, {
            code,
            status,
          });
        }

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, currentDelay));
          continue;
        }
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

  logger.error('Final failure: Analyzer wake-up failed: maximum retry attempts exhausted');
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
  logger.info('Analyze request: Sending POST to analyzer', {
    url,
    mimeType,
    imageType,
    filePath: absoluteFilePath,
  });

  const fileBuffer = fs.readFileSync(absoluteFilePath);
  const maxAttempts = 3;
  const delayMs = 3000;
  let attempt429Count = 0;
  const max429Attempts = 3;

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

      const method = err.config?.method?.toUpperCase() || 'POST';
      const requestUrl = err.config?.url
        ? (err.config.url.startsWith('http') ? err.config.url : `${env.analyzer.baseUrl}${err.config.url}`)
        : url;
      const responseStatus = status || 'No Response/Unknown';
      const responseBody = err.response?.data || err.message;

      // Determine which service generated it
      let sourceService = 'Unknown';
      if (status) {
        const isRender =
          err.response?.headers?.['server']?.toLowerCase().includes('render') ||
          err.response?.headers?.['via']?.toLowerCase().includes('render') ||
          (typeof responseBody === 'string' && responseBody.includes('Render'));
        sourceService = isRender ? 'Render Load Balancer' : 'FastAPI Analyzer Service';
      }

      logger.error('Analyze request failed', {
        url: requestUrl,
        method,
        status: responseStatus,
        body: responseBody,
        sourceService,
      });

      const is429 = status === 429;
      if (is429) {
        attempt429Count++;
        if (attempt429Count > max429Attempts) {
          logger.error('Final failure: Analyzer /analyze request received HTTP 429 and exceeded maximum 429 retries', {
            attempt429Count,
            max429Attempts,
          });
          throw err;
        }
      }

      const isTransient =
        !err.response ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        is429 ||
        [
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ENOTFOUND',
          'ECONNRESET',
          'EHOSTUNREACH',
          'ENETUNREACH',
          'EPIPE',
        ].includes(code) ||
        err.message?.toLowerCase().includes('timeout');

      if (isTransient && attempt < maxAttempts) {
        let currentDelay = delayMs;
        if (is429) {
          const retryAfterHeader = err.response?.headers?.['retry-after'];
          if (retryAfterHeader) {
            const seconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(seconds)) {
              currentDelay = seconds * 1000;
            } else {
              const dateMs = Date.parse(retryAfterHeader);
              if (!isNaN(dateMs)) {
                currentDelay = Math.max(0, dateMs - Date.now());
              }
            }
            logger.info(`Respecting Retry-After header: waiting ${currentDelay / 1000}s...`);
          } else {
            // controlled exponential backoff
            currentDelay = Math.min(30000, 2000 * Math.pow(2, attempt429Count));
            logger.info(`HTTP 429 with no Retry-After header. Using exponential backoff: waiting ${currentDelay / 1000}s...`);
          }
        } else {
          logger.warn(`Retry: Analyzer analyze request failed transiently (attempt ${attempt}/${maxAttempts}). Retrying in ${currentDelay / 1000}s...`, {
            error: err.message,
            code,
            status,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, currentDelay));
        continue;
      }

      const errorDetails = {
        url,
        message: err.message,
        status,
        statusText: err.response?.statusText,
        responseData: err.response?.data,
        sourceService,
      };
      logger.error('Final failure: Analyzer request failed permanently', errorDetails);
      throw err;
    }
  }
  logger.error('Final failure: Analyzer request failed after maximum retry attempts');
  throw new Error('Analyzer request failed after maximum retry attempts');
}


