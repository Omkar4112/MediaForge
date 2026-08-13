import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { runMigrations } from './config/migrate';

// In Docker Compose the worker runs as a separate container
// (node dist/workers/imageProcessing.worker.js). On Render (single-process),
// set START_WORKER_IN_PROCESS=true so the BullMQ worker runs inside the
// HTTP-server process.
let workerModule: any = null;
let server: any = null;

async function start() {
  try {
    logger.info('Checking and running database migrations...');
    await runMigrations();
    logger.info('Database migration step complete.');

    if (process.env.START_WORKER_IN_PROCESS === 'true') {
      logger.info('START_WORKER_IN_PROCESS=true — starting BullMQ worker in-process');
      try {
        // Resolve module path without file extension so node/ts-node-dev handles it correctly in both dev and production.
        workerModule = require('./workers/imageProcessing.worker');
      } catch (err) {
        logger.error('Failed to start in-process worker', { error: (err as Error).message });
      }
    } else {
      logger.info('START_WORKER_IN_PROCESS is not set — worker will NOT run in this process');
    }

    const app = createApp();

    server = app.listen(env.port, () => {
      logger.info(`MediaForge backend API listening on port ${env.port} (env: ${env.nodeEnv})`);
    });
  } catch (err) {
    logger.error('Failed to start backend server during initialization', { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  }
}

function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully.`);

  const serverClosePromise = server
    ? new Promise<void>((resolve) => {
        server.close(() => {
          logger.info('HTTP server closed.');
          resolve();
        });
      })
    : Promise.resolve();

  const workerClosePromise = workerModule && workerModule.worker
    ? workerModule.worker.close().then(() => {
        logger.info('Worker closed.');
      }).catch((err: any) => {
        logger.error('Error during worker shutdown', { error: err.message });
      })
    : Promise.resolve();

  Promise.all([serverClosePromise, workerClosePromise]).then(() => {
    logger.info('All services shut down gracefully.');
    process.exit(0);
  }).catch((err) => {
    logger.error('Error during graceful shutdown', { error: err.message });
    process.exit(1);
  });

  setTimeout(() => {
    logger.warn('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();

