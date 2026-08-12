import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';

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
