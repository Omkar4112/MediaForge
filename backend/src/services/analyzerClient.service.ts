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
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  }
});

// --- Cached analyzer health + background wake-up ---
//
// Problem to solve:
//   The frontend polls GET /health every ~2s.  Each poll must return quickly.
//   But during a Render cold-start the analyzer takes 30-120s to boot.
//   A single short-timeout probe per poll will always time out and the
//   frontend's 90s window expires before the analyzer is ever seen "up".
//
// Solution:
//   1. checkAnalyzerHealthDirect() always returns IMMEDIATELY from a cache.
//   2. When the cache is stale or negative, we fire ONE background wake-up
//      loop that keeps pinging the analyzer every 5s (15s timeout each)
//      until it responds 200 {"status":"ok"}.
//   3. The background loop updates the cache the moment the analyzer is up.
//   4. Subsequent frontend polls instantly see the fresh positive cache.
//   5. Only one background loop runs at a time (singleton guard).

export interface WakeLogEntry {
  timestamp: string;
  message: string;
  error?: any;
}

let _analyzerCacheResult: boolean | null = null;
let _analyzerCacheExpiry = 0;
let _analyzerInflight: Promise<boolean> | null = null;
let _backgroundWakeRunning = false;
const wakeLogs: WakeLogEntry[] = [];

const ANALYZER_CACHE_TTL_OK_MS = 30_000;   // cache "up" for 30s
const ANALYZER_CACHE_TTL_DOWN_MS = 4_000;   // cache "down" for 4s (re-check fast)

export function addWakeLog(message: string, error?: any): void {
  const entry: WakeLogEntry = {
    timestamp: new Date().toISOString(),
    message,
    error: error ? {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data,
      headers: error.response?.headers,
    } : undefined,
  };
  wakeLogs.push(entry);
  if (wakeLogs.length > 50) {
    wakeLogs.shift();
  }
  if (error) {
    logger.warn(message, { error: error.message, code: error.code });
  } else {
    logger.info(message);
  }
}

export function getWakeLogs(): any {
  return {
    baseUrl: env.analyzer.baseUrl,
    backgroundWakeRunning: _backgroundWakeRunning,
    cacheResult: _analyzerCacheResult,
    cacheExpiry: _analyzerCacheExpiry ? new Date(_analyzerCacheExpiry).toISOString() : null,
    timestamp: new Date().toISOString(),
    logs: wakeLogs,
  };
}

/** Fire-and-forget background loop that pings the analyzer until it wakes. */
function _startBackgroundWake(): void {
  if (_backgroundWakeRunning) return;       // singleton guard
  _backgroundWakeRunning = true;

  const maxAttempts = 15;                   // 15 attempts × 12s = 180s coverage
  const delayMs = 12_000;                   // 12s delay to prevent Render's hibernate rate limit
  const perRequestTimeout = 15_000;         // 15s timeout per request

  addWakeLog(`BACKGROUND ANALYZER WAKE LOOP STARTED. Target: ${env.analyzer.baseUrl}, maxAttempts: ${maxAttempts}`);

  (async () => {
    // Wait first to avoid back-to-back requests with the quick probe that triggered this
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Hit ONLY /health to check status and wake the service.
        // Doing multiple requests (like '/' and '/health') back-to-back
        // triggers Render's strict hibernate-rate-limiter (429).
        addWakeLog(`[AnalyzerWake] Attempt ${attempt}/${maxAttempts} - Starting GET ${env.analyzer.baseUrl}/health`);
        const response = await client.get<{ status: string }>('/health', {
          timeout: perRequestTimeout,
        });

        const ok = response.status === 200 && response.data?.status === 'ok';
        addWakeLog(`[AnalyzerWake] Attempt ${attempt}/${maxAttempts} - Health GET response: status=${response.status}, body=${JSON.stringify(response.data)}, ok=${ok}`);

        if (ok) {
          addWakeLog(`[AnalyzerWake] Analyzer became ready on attempt ${attempt}`);
          _analyzerCacheResult = true;
          _analyzerCacheExpiry = Date.now() + ANALYZER_CACHE_TTL_OK_MS;
          _backgroundWakeRunning = false;
          return;
        }
      } catch (err: any) {
        addWakeLog(`[AnalyzerWake] Attempt ${attempt}/${maxAttempts} - Health GET failed`, err);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    addWakeLog('[AnalyzerWake] BACKGROUND ANALYZER WAKE LOOP EXHAUSTED ALL ATTEMPTS. Analyzer did not become ready.');
    _backgroundWakeRunning = false;
  })().catch((err) => {
    addWakeLog('[AnalyzerWake] BACKGROUND ANALYZER WAKE LOOP UNEXPECTED ERROR', err);
    _backgroundWakeRunning = false;
  });
}

export async function checkAnalyzerHealthDirect(): Promise<boolean> {
  const now = Date.now();

  // CRITICAL: If the background wake loop is already running, do NOT send any new probe.
  // Returning immediately prevents overlapping requests that trigger Render's 429 rate limiter.
  if (_backgroundWakeRunning) {
    return _analyzerCacheResult ?? false;
  }

  // Return cached result if fresh
  if (_analyzerCacheResult !== null && now < _analyzerCacheExpiry) {
    if (!_analyzerCacheResult) {
      addWakeLog('[HealthCheck] Cached result is DOWN, background loop is not running. Starting background loop.');
      _startBackgroundWake();
    }
    return _analyzerCacheResult;
  }

  // Cache is stale and no background loop is running
  if (_analyzerInflight) {
    return _analyzerInflight;
  }

  _analyzerInflight = (async () => {
    try {
      addWakeLog(`[HealthCheck] Cache stale, sending quick health probe to ${env.analyzer.baseUrl}/health`);
      const response = await client.get<{ status: string }>('/health', {
        timeout: 5000,
      });
      const healthy = response.status === 200 && response.data?.status === 'ok';
      addWakeLog(`[HealthCheck] Quick health probe result: status=${response.status}, healthy=${healthy}`);
      _analyzerCacheResult = healthy;
      _analyzerCacheExpiry = Date.now() + (healthy ? ANALYZER_CACHE_TTL_OK_MS : ANALYZER_CACHE_TTL_DOWN_MS);

      if (!healthy) {
        _startBackgroundWake();
      }
      return healthy;
    } catch (err: any) {
      addWakeLog('[HealthCheck] Quick health probe failed', err);
      _analyzerCacheResult = false;
      _analyzerCacheExpiry = Date.now() + ANALYZER_CACHE_TTL_DOWN_MS;
      _startBackgroundWake();
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
  _backgroundWakeRunning = false;
  wakeLogs.length = 0;
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


