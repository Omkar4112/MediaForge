import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';

// In Docker Compose the worker runs as a separate container
// (node dist/workers/imageProcessing.worker.js). On Render (single-process),
// set START_WORKER_IN_PROCESS=true so the BullMQ worker runs inside the
// HTTP-server process.
if (process.env.START_WORKER_IN_PROCESS === 'true') {
  logger.info('START_WORKER_IN_PROCESS=true — starting BullMQ worker in-process');
  import('./workers/imageProcessing.worker.js').catch((err) => {
    logger.error('Failed to start in-process worker', { error: (err as Error).message });
  });
} else {
  logger.info('START_WORKER_IN_PROCESS is not set — worker will NOT run in this process');
}

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info(`MediaForge backend API listening on port ${env.port} (env: ${env.nodeEnv})`);
});

function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down HTTP server gracefully.`);
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
