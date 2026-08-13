import { Job } from 'bullmq';
import { logger } from '../utils/logger';
import { storageService } from '../services/storage.service';
import { analyzeImage, CheckStatus } from '../services/analyzerClient.service';
import { checkDuplicate } from '../services/duplicateDetection.service';
import { computeVerdict, CheckSummary } from '../services/verdict.service';
import type { ImageProcessingJobData } from '../queues/imageProcessing.queue';
import * as jobRepository from '../repositories/job.repository';
import * as imageRepository from '../repositories/image.repository';
import * as resultRepository from '../repositories/result.repository';

export async function processImageJob(job: Job<ImageProcessingJobData>): Promise<void> {
  const { jobId, imageId, storagePath, mimeType, imageType = 'generic' } = job.data;
  try {
    logger.info('Starting image processing job', { jobId, imageId, attempt: job.attemptsMade + 1 });

    await jobRepository.markJobProcessing(jobId);

    if (!storageService.exists(storagePath)) {
      throw new Error(`Stored file not found for image ${imageId} at ${storagePath}`);
    }

    const absolutePath = storageService.getAbsolutePath(storagePath);

    // 1. Run all CV/OCR checks in the Python analyzer service.
    const analysis = await analyzeImage(absolutePath, mimeType, imageType);

    // 2. Persist phash + dimensions discovered by the analyzer back onto the image row.
    const width = Number(analysis.dimensions.width ?? 0) || null;
    const height = Number(analysis.dimensions.height ?? 0) || null;
    logger.info('Updating image dimensions and hash in DB', { imageId, width, height, phash: analysis.phash });
    await imageRepository.updateImageDimensionsAndHash(imageId, width ?? 0, height ?? 0, analysis.phash ?? null);
    logger.info('Successfully updated image dimensions and hash in DB', { imageId });

    // 3. Duplicate detection is done in the backend so it can query prior images in Postgres.
    const duplicateResult = await checkDuplicate(imageId, analysis.phash ?? null);

    const checkResults: Array<{
      checkType: string;
      status: CheckStatus;
      score: number | null;
      result: Record<string, unknown>;
    }> = [
      { checkType: 'blur', status: analysis.blur.status, score: (analysis.blur.score as number) ?? null, result: analysis.blur },
      { checkType: 'brightness', status: analysis.brightness.status, score: (analysis.brightness.score as number) ?? null, result: analysis.brightness },
      { checkType: 'duplicate', status: duplicateResult.status, score: duplicateResult.similarity !== null ? 1.0 - duplicateResult.similarity : 1.0, result: { ...duplicateResult } },
      { checkType: 'ocr', status: analysis.ocr.status, score: (analysis.ocr.score as number) ?? null, result: analysis.ocr },
      { checkType: 'numberPlate', status: analysis.numberPlate.status, score: (analysis.numberPlate.score as number) ?? null, result: analysis.numberPlate },
      { checkType: 'dimensions', status: analysis.dimensions.status, score: (analysis.dimensions.score as number) ?? null, result: analysis.dimensions },
      { checkType: 'photoOfPhoto', status: analysis.photoOfPhoto.status, score: (analysis.photoOfPhoto.score as number) ?? null, result: analysis.photoOfPhoto },
      { checkType: 'tampering', status: analysis.tampering.status, score: (analysis.tampering.score as number) ?? null, result: analysis.tampering },
    ];

    logger.info('Inserting/updating check results in DB', { jobId, checksCount: checkResults.length });
    for (const check of checkResults) {
      await resultRepository.upsertAnalysisResult({
        jobId,
        checkType: check.checkType,
        status: check.status,
        score: check.score,
        result: check.result,
      });
    }
    logger.info('Successfully inserted/updated check results in DB', { jobId });

    const summaries: CheckSummary[] = checkResults.map((c) => ({
      checkType: c.checkType,
      status: c.status,
      score: c.score,
    }));
    const { overallStatus, confidence } = computeVerdict(summaries);

    logger.info('Marking job as completed in DB', { jobId, overallStatus, confidence });
    await jobRepository.markJobCompleted(jobId, overallStatus, confidence);
    logger.info('Successfully marked job as completed in DB', { jobId });

    logger.info('Completed image processing job', { jobId, imageId, overallStatus, confidence });
  } catch (err) {
    logger.error('Exception thrown during image processing job execution', {
      jobId,
      imageId,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    throw err;
  }
}

/**
 * Called from the BullMQ Worker's 'failed' event. BullMQ itself retries the
 * job (per queue defaultJobOptions.attempts with exponential backoff); this
 * handler only persists a terminal "failed" state + reason once the final
 * retry attempt has been exhausted, so pending/processing jobs never get
 * stuck silently.
 */
export async function handleJobExhausted(job: Job<ImageProcessingJobData>, err: Error): Promise<void> {
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= maxAttempts) {
    const detailedError = `${err.message}\n${err.stack || ''}`;
    await jobRepository.markJobFailed(job.data.jobId, detailedError);
  }
}

