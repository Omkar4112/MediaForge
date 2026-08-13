import { Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { env } from '../config/env';

export interface ImageProcessingJobData {
  jobId: string;
  imageId: string;
  storagePath: string;
  mimeType: string;
  imageType?: string;
}

export const imageProcessingQueue = new Queue<ImageProcessingJobData>(env.queue.name, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: env.queue.maxAttempts,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

export async function enqueueImageProcessingJob(data: ImageProcessingJobData): Promise<void> {
  try {
    // Use the DB job id as the BullMQ job id to make re-enqueueing idempotent
    // and to protect against duplicate processing of the same logical job.
    await imageProcessingQueue.add('analyze-image', data, { jobId: data.jobId });
  } catch (err) {
    throw new Error(`Redis queue unavailable: ${(err as Error).message}`);
  }
}
