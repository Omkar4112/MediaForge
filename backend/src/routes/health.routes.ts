import { Router } from 'express';
import { checkDbConnection } from '../config/db';
import IORedis from 'ioredis';
import { env } from '../config/env';

const router = Router();

const HEALTH_CHECK_TIMEOUT_MS = 3000;

/**
 * Create a short-lived Redis connection specifically for health checks.
 * Unlike createRedisConnection() (tuned for BullMQ's long-running blocking
 * commands), this connection uses enableOfflineQueue: false so that commands
 * fail immediately if the socket isn't ready, preventing the endpoint from
 * hanging forever.
 */
function checkRedisHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy: boolean, conn?: IORedis) => {
      if (settled) return;
      settled = true;
      if (conn) {
        conn.disconnect(); // forceful close, no queued commands
      }
      resolve(healthy);
    };

    // Timeout guard – always resolves within HEALTH_CHECK_TIMEOUT_MS
    const timer = setTimeout(() => finish(false), HEALTH_CHECK_TIMEOUT_MS);

    try {
      const redisUrl = process.env.REDIS_URL;
      const conn = redisUrl
        ? new IORedis(redisUrl, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
            lazyConnect: true,
            ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
          })
        : new IORedis({
            host: env.redis.host,
            port: env.redis.port,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
            lazyConnect: true,
          });

      conn.on('error', () => {
        // Swallow connection errors – finish() will handle the result
      });

      conn
        .connect()
        .then(() => conn.ping())
        .then(() => {
          clearTimeout(timer);
          finish(true, conn);
        })
        .catch(() => {
          clearTimeout(timer);
          finish(false, conn);
        });
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

router.get('/health', async (_req, res) => {
  let dbHealthy = false;
  let redisHealthy = false;

  try {
    dbHealthy = await checkDbConnection();
  } catch {
    dbHealthy = false;
  }

  redisHealthy = await checkRedisHealth();

  const isHealthy = dbHealthy && redisHealthy;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    db: dbHealthy ? 'up' : 'down',
    redis: redisHealthy ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
});

export default router;

