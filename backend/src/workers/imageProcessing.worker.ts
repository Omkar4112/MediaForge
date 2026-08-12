import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { ImageProcessingJobData } from '../queues/imageProcessing.queue';
import { processImageJob, handleJobExhausted } from './jobProcessor';

const worker = new Worker<ImageProcessingJobData>(
  env.queue.name,
  async (job) => {
    await processImageJob(job);
  },
  {
    connection: createRedisConnection(),
    concurrency: env.queue.concurrency,
  }
);

worker.on('completed', (job) => {
  logger.info('Job completed', { jobId: job.id });
});

worker.on('failed', async (job, err) => {
  logger.error('Job failed', { jobId: job?.id, error: err.message, attemptsMade: job?.attemptsMade });
  if (job) {
    await handleJobExhausted(job, err).catch((e) =>
      logger.error('Failed to persist job failure', { error: (e as Error).message })
    );
  }
});

worker.on('error', (err) => {
  logger.error('Worker-level error', { error: err.message });
});

function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down worker gracefully.`);
  worker
    .close()
    .then(() => {
      logger.info('Worker closed.');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Error during worker shutdown', { error: err.message });
      process.exit(1);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

logger.info(`Image processing worker started (concurrency=${env.queue.concurrency})`);
