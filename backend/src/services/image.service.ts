import sizeOf from 'image-size';
import { AppError } from '../utils/AppError';
import { storageService } from './storage.service';
import * as imageRepository from '../repositories/image.repository';
import * as jobRepository from '../repositories/job.repository';
import * as resultRepository from '../repositories/result.repository';
import { enqueueImageProcessingJob } from '../queues/imageProcessing.queue';
import { logger } from '../utils/logger';

export interface UploadResult {
  processingId: string;
  status: string;
}

export async function handleImageUpload(file: Express.Multer.File, imageType?: string): Promise<UploadResult> {
  if (!file) {
    throw new AppError(400, 'No image file provided. Use multipart field name "image".');
  }

  // Best-effort dimension probe. If the file isn't a decodable image, reject early
  // instead of queuing a job that is guaranteed to fail downstream.
  let dimensions: { width?: number; height?: number };
  try {
    dimensions = sizeOf(file.buffer);
  } catch (err) {
    throw new AppError(400, 'Uploaded file is not a valid/decodable image');
  }

  const { storagePath } = await storageService.save(file.buffer, file.originalname, file.mimetype);

  const image = await imageRepository.createImage({
    originalFilename: file.originalname,
    storagePath,
    mimeType: file.mimetype,
    fileSize: file.size,
    imageType,
  });

  if (dimensions.width && dimensions.height) {
    await imageRepository.updateImageDimensionsAndHash(image.id, dimensions.width, dimensions.height, null);
  }

  const job = await jobRepository.createJob(image.id);

  try {
    await enqueueImageProcessingJob({
      jobId: job.id,
      imageId: image.id,
      storagePath,
      mimeType: file.mimetype,
      imageType: image.image_type,
    });
  } catch (err) {
    // If enqueueing fails, mark the job failed rather than leaving it stuck in "pending" forever.
    logger.error('Failed to enqueue image processing job', { jobId: job.id, error: (err as Error).message });
    await jobRepository.markJobFailed(job.id, 'Failed to enqueue processing job');
    throw new AppError(503, 'Failed to schedule image processing. Please retry.');
  }

  return { processingId: job.id, status: job.status };
}

export async function getJobStatus(processingId: string) {
  const job = await jobRepository.findJobById(processingId);
  if (!job) {
    throw new AppError(404, `No processing job found for id ${processingId}`);
  }
  return {
    processingId: job.id,
    status: job.status,
    attempts: job.attempts,
    errorMessage: job.error_message,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    createdAt: job.created_at,
  };
}

export async function getJobResults(processingId: string) {
  const job = await jobRepository.findJobById(processingId);
  if (!job) {
    throw new AppError(404, `No processing job found for id ${processingId}`);
  }

  if (job.status !== 'completed' && job.status !== 'failed') {
    return {
      processingId: job.id,
      status: job.status,
      message: 'Results are not ready yet. Poll the status endpoint until status is "completed" or "failed".',
    };
  }

  if (job.status === 'failed') {
    return {
      processingId: job.id,
      status: job.status,
      errorMessage: job.error_message,
    };
  }

  // Fetch image metadata for the full response shape
  const image = await imageRepository.findImageById(job.image_id);

  const results = await resultRepository.findResultsByJobId(job.id);
  const checks: Record<string, unknown> = {};
  let ocrText: string | null = null;

  for (const r of results) {
    const checkData: Record<string, unknown> = {
      status: r.status,
      score: r.score !== null ? Number(r.score) : null,
      ...r.result,
    };
    checks[r.check_type] = checkData;

    // Extract OCR text from the ocr check result
    if (r.check_type === 'ocr' && r.result && typeof r.result['text'] === 'string') {
      ocrText = (r.result['text'] as string).trim() || null;
    }
  }

  return {
    processingId: job.id,
    imageId: job.image_id,
    status: job.status,
    overallStatus: job.overall_status,
    confidence: job.confidence !== null ? Number(job.confidence) : null,

    // Image metadata
    filename: image?.storage_path ?? null,
    originalName: image?.original_filename ?? null,
    mimeType: image?.mime_type ?? null,
    fileSizeBytes: image?.file_size ?? null,
    width: image?.width ?? null,
    height: image?.height ?? null,
    imageType: image?.image_type ?? 'generic',

    // Extracted text
    ocrText,

    // Individual check results
    checks,

    createdAt: job.created_at,
  };
}

