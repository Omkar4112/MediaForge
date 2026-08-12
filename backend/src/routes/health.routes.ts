import { Router } from 'express';
import { checkDbConnection } from '../config/db';

const router = Router();

router.get('/health', async (_req, res) => {
  const dbHealthy = await checkDbConnection();
  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? 'ok' : 'degraded',
    db: dbHealthy ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
});

export default router;
