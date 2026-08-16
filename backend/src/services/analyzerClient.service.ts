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

// --- Cached / throttled analyzer health check ---
// The backend /health endpoint is polled every ~2s by the frontend.
// Without throttling, each poll hits the analyzer, flooding it during
// cold-start and triggering HTTP 429 from Render's rate-limiter.
//
// Cache strategy:
//   - positive result ("ok") cached for 30s
//   - negative result (down/error) cached for 10s (allows reasonably fast re-probe)
//   - concurrent requests coalesce onto a single in-flight check
let _analyzerCacheResult: boolean | null = null;
let _analyzerCacheExpiry = 0;
let _analyzerInflight: Promise<boolean> | null = null;

const ANALYZER_CACHE_TTL_OK_MS = 30_000;   // 30s when healthy
const ANALYZER_CACHE_TTL_DOWN_MS = 10_000;  // 10s when unhealthy

export async function checkAnalyzerHealthDirect(): Promise<boolean> {
  const now = Date.now();

  // Return cached result if fresh
  if (_analyzerCacheResult !== null && now < _analyzerCacheExpiry) {
    return _analyzerCacheResult;
  }

  // Coalesce concurrent callers onto a single in-flight request
  if (_analyzerInflight) {
    return _analyzerInflight;
  }

  _analyzerInflight = (async () => {
    try {
      const response = await client.get<{ status: string }>('/health', {
        timeout: 5000,
      });
      const healthy = response.status === 200 && response.data?.status === 'ok';
      _analyzerCacheResult = healthy;
      _analyzerCacheExpiry = Date.now() + (healthy ? ANALYZER_CACHE_TTL_OK_MS : ANALYZER_CACHE_TTL_DOWN_MS);
      return healthy;
    } catch (err) {
      _analyzerCacheResult = false;
      _analyzerCacheExpiry = Date.now() + ANALYZER_CACHE_TTL_DOWN_MS;
      return false;
    } finally {
      _analyzerInflight = null;
    }
  })();

  return _analyzerInflight;
}

/** @internal — test-only helper to reset cached state between test cases */
export function _resetAnalyzerCacheForTesting(): void {
  _analyzerCacheResult = null;
  _analyzerCacheExpiry = 0;
  _analyzerInflight = null;
}

export async function wakeAnalyzer(): Promise<void> {
  const healthUrl = `${env.analyzer.baseUrl}/health`;
  const maxAttempts = 30;
  const delayMs = 5000;
  let attempt429Count = 0;
  const max429Attempts = 5;

  logger.info(`Waking analyzer: Starting health check verification loop against ${healthUrl}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info(`Analyzer wake-up: Attempt ${attempt}/${maxAttempts} to GET ${healthUrl}`);
    try {
      const response = await client.get<{ status: string }>('/health', {
        timeout: 10000,
      });

      const hasStatusOk = response.status === 200 && response.data?.status === 'ok';
      logger.info(`Analyzer health check response status: ${response.status}, body: ${JSON.stringify(response.data)}`);

      if (hasStatusOk) {
        logger.info(`Analyzer became ready: Health check passed on attempt ${attempt}`);
        return;
      }

      logger.warn(`Analyzer health response status is ${response.status} but response is not "ok"`, {
        data: response.data,
        attempt,
      });
      
      if (attempt < maxAttempts) {
        logger.info(`Retry reason: Response status is 200 but body is not "ok". Retrying in ${delayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
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

      logger.warn(`Analyzer health response status: ${responseStatus}, error: ${err.message}`, {
        url: requestUrl,
        method,
        code,
        sourceService,
        attempt,
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
          'ECONNABORTED',
        ].includes(code) ||
        err.message?.toLowerCase().includes('timeout');

      if (isTransient) {
        let currentDelay = delayMs;
        let retryReason = `Transient network/service error (status: ${responseStatus}, code: ${code || 'unknown'})`;
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
            retryReason = `HTTP 429: Respecting Retry-After header`;
          } else {
            // controlled exponential backoff
            currentDelay = Math.min(30000, 2000 * Math.pow(2, attempt429Count));
            retryReason = `HTTP 429: No Retry-After header, using exponential backoff`;
          }
        }

        logger.info(`Retry reason: ${retryReason}. Retrying in ${currentDelay / 1000}s...`, {
          code,
          status,
          attempt,
        });

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
  const fileBuffer = fs.readFileSync(absoluteFilePath);
  const maxAttempts = 3;
  const delayMs = 3000;
  let attempt429Count = 0;
  const max429Attempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info(`POST /analyze attempt ${attempt}/${maxAttempts} for file: ${path.basename(absoluteFilePath)}`);
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

      logger.info(`POST /analyze response status: ${response.status} (Success)`);
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

      logger.warn(`POST /analyze attempt ${attempt}/${maxAttempts} failed: status: ${responseStatus}, error: ${err.message}`, {
        url: requestUrl,
        method,
        code,
        sourceService,
      });

      const is429 = status === 429;
      if (is429) {
        attempt429Count++;
        if (attempt429Count > max429Attempts) {
          logger.error(`Final failure: Analyzer /analyze request received HTTP 429 and exceeded maximum 429 retries`, {
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
          'ECONNABORTED',
        ].includes(code) ||
        err.message?.toLowerCase().includes('timeout');

      if (isTransient && attempt < maxAttempts) {
        let currentDelay = delayMs;
        let retryReason = `Transient network/service error (status: ${responseStatus}, code: ${code || 'unknown'})`;
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
            retryReason = `HTTP 429: Respecting Retry-After header`;
          } else {
            // controlled exponential backoff
            currentDelay = Math.min(30000, 2000 * Math.pow(2, attempt429Count));
            retryReason = `HTTP 429: No Retry-After header, using exponential backoff`;
          }
        }

        logger.info(`Retry reason: ${retryReason}. Retrying in ${currentDelay / 1000}s...`, {
          code,
          status,
          attempt,
        });
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
        attempt,
      };
      logger.error('Final failure: Analyzer request failed permanently', errorDetails);
      throw err;
    }
  }
  logger.error('Final failure: Analyzer request failed after maximum retry attempts');
  throw new Error('Analyzer request failed after maximum retry attempts');
}


