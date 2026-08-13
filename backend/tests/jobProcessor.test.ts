jest.mock('../src/config/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../src/services/storage.service');
jest.mock('../src/services/analyzerClient.service');
jest.mock('../src/services/duplicateDetection.service');
jest.mock('../src/repositories/job.repository');
jest.mock('../src/repositories/image.repository');
jest.mock('../src/repositories/result.repository');
jest.mock('../src/queues/imageProcessing.queue');

import { storageService } from '../src/services/storage.service';
import { analyzeImage } from '../src/services/analyzerClient.service';
import { checkDuplicate } from '../src/services/duplicateDetection.service';
import * as jobRepository from '../src/repositories/job.repository';
import * as imageRepository from '../src/repositories/image.repository';
import * as resultRepository from '../src/repositories/result.repository';
import { processImageJob, handleJobExhausted } from '../src/workers/jobProcessor';

const mockAnalysis = {
  blur: { status: 'pass', score: 0.9 },
  brightness: { status: 'pass', score: 0.9 },
  ocr: { status: 'pass', score: 0.8, text: 'MH12AB1234' },
  numberPlate: { status: 'pass', score: 0.85, detected: true, validFormat: true },
  dimensions: { status: 'pass', score: 1, width: 1920, height: 1080 },
  photoOfPhoto: { status: 'pass', score: 1, suspicious: false },
  tampering: { status: 'pass', score: 1, suspicious: false },
  phash: 'abcd1234',
};

function buildJob(overrides: Partial<{ jobId: string; imageId: string; storagePath: string; mimeType: string; imageType: string }> = {}) {
  return {
    data: {
      jobId: 'job-1',
      imageId: 'image-1',
      storagePath: 'file.jpg',
      mimeType: 'image/jpeg',
      ...overrides,
    },
    attemptsMade: 0,
  } as any;
}

describe('processImageJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (storageService.exists as jest.Mock).mockReturnValue(true);
    (storageService.getAbsolutePath as jest.Mock).mockReturnValue('/abs/path/file.jpg');
    (analyzeImage as jest.Mock).mockResolvedValue(mockAnalysis);
    (checkDuplicate as jest.Mock).mockResolvedValue({
      status: 'pass',
      isDuplicate: false,
      closestMatchImageId: null,
      hammingDistance: null,
      similarity: null,
    });
  });

  it('processes a successful job end-to-end and marks it completed', async () => {
    const job = buildJob();
    await processImageJob(job);

    expect(jobRepository.markJobProcessing).toHaveBeenCalledWith('job-1');
    expect(imageRepository.updateImageDimensionsAndHash).toHaveBeenCalledWith('image-1', 1920, 1080, 'abcd1234');
    expect(resultRepository.upsertAnalysisResult).toHaveBeenCalledTimes(8);
    expect(jobRepository.markJobCompleted).toHaveBeenCalledWith('job-1', 'usable', expect.any(Number));
  });

  it('processes a generic (non-vehicle) job successfully with numberPlate status set to not_applicable', async () => {
    const genericMockAnalysis = {
      ...mockAnalysis,
      numberPlate: { status: 'not_applicable' },
    };
    (analyzeImage as jest.Mock).mockResolvedValue(genericMockAnalysis);

    const job = buildJob({ imageType: 'generic' });
    await processImageJob(job);

    expect(jobRepository.markJobProcessing).toHaveBeenCalledWith('job-1');
    expect(analyzeImage).toHaveBeenCalledWith('/abs/path/file.jpg', 'image/jpeg', 'generic');
    expect(resultRepository.upsertAnalysisResult).toHaveBeenCalledWith(
      expect.objectContaining({
        checkType: 'numberPlate',
        status: 'not_applicable',
      })
    );
    expect(jobRepository.markJobCompleted).toHaveBeenCalledWith('job-1', 'usable', expect.any(Number));
  });

  it('throws and does not mark completed when the stored file is missing', async () => {
    (storageService.exists as jest.Mock).mockReturnValue(false);
    const job = buildJob();

    await expect(processImageJob(job)).rejects.toThrow(/Stored file not found/);
    expect(jobRepository.markJobCompleted).not.toHaveBeenCalled();
  });

  it('propagates analyzer errors so BullMQ can retry the job', async () => {
    (analyzeImage as jest.Mock).mockRejectedValue(new Error('analyzer unreachable'));
    const job = buildJob();

    await expect(processImageJob(job)).rejects.toThrow('analyzer unreachable');
    expect(jobRepository.markJobCompleted).not.toHaveBeenCalled();
  });

  it('marks job as "review" overall status when single blur check fails', async () => {
    (analyzeImage as jest.Mock).mockResolvedValue({
      ...mockAnalysis,
      blur: { status: 'fail', score: 0.1 },
    });
    const job = buildJob();
    await processImageJob(job);

    expect(jobRepository.markJobCompleted).toHaveBeenCalledWith('job-1', 'review', expect.any(Number));
  });
});

describe('handleJobExhausted (retry behaviour)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does NOT mark the job failed while retry attempts remain', async () => {
    const job = { data: { jobId: 'job-1' }, attemptsMade: 1, opts: { attempts: 3 } } as any;
    await handleJobExhausted(job, new Error('transient error'));
    expect(jobRepository.markJobFailed).not.toHaveBeenCalled();
  });

  it('marks the job permanently failed once all retry attempts are exhausted', async () => {
    const job = { data: { jobId: 'job-1' }, attemptsMade: 3, opts: { attempts: 3 } } as any;
    await handleJobExhausted(job, new Error('permanent error'));
    expect(jobRepository.markJobFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('permanent error'));
  });
});
