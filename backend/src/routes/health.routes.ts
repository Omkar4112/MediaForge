import { Router } from 'express';
import { checkDbConnection } from '../config/db';
import { createRedisConnection } from '../config/redis';

const router = Router();

router.get('/health', async (_req, res) => {
  let dbHealthy = false;
  let redisHealthy = false;

  try {
    dbHealthy = await checkDbConnection();
  } catch {
    dbHealthy = false;
  }

  try {
    const redis = createRedisConnection();
    await redis.ping();
    redisHealthy = true;
    await redis.quit();
  } catch {
    redisHealthy = false;
  }

  const isHealthy = dbHealthy && redisHealthy;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    db: dbHealthy ? 'up' : 'down',
    redis: redisHealthy ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
});

export default router;
