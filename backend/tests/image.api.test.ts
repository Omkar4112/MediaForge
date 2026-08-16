jest.mock('../src/services/image.service');
jest.mock('../src/queues/imageProcessing.queue');
jest.mock('../src/services/analyzerClient.service', () => ({
  checkAnalyzerHealthDirect: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  checkDbConnection: jest.fn().mockResolvedValue(true),
}));
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    return {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      disconnect: jest.fn(),
    };
  });
});

import request from 'supertest';
import { createApp } from '../src/app';
import * as imageService from '../src/services/image.service';
import { AppError } from '../src/utils/AppError';

const app = createApp();

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('POST /api/v1/images', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 202 and a processingId for a valid upload', async () => {
    (imageService.handleImageUpload as jest.Mock).mockResolvedValue({
      processingId: VALID_UUID,
      status: 'pending',
    });

    const response = await request(app)
      .post('/api/v1/images')
      .attach('image', Buffer.from([0xff, 0xd8, 0xff, 0xdb]), {
        filename: 'test.jpg',
        contentType: 'image/jpeg',
      });

    expect(response.status).toBe(202);
    expect(response.body.processingId).toBe(VALID_UUID);
    expect(response.body.status).toBe('pending');
  });

  it('passes generic imageType to imageService when specified in body', async () => {
    (imageService.handleImageUpload as jest.Mock).mockResolvedValue({
      processingId: VALID_UUID,
      status: 'pending',
    });

    const response = await request(app)
      .post('/api/v1/images')
      .field('imageType', 'shop_branding')
      .attach('image', Buffer.from([0xff, 0xd8, 0xff, 0xdb]), {
        filename: 'test.jpg',
        contentType: 'image/jpeg',
      });

    expect(response.status).toBe(202);
    expect(imageService.handleImageUpload).toHaveBeenCalledWith(
      expect.any(Object),
      'shop_branding'
    );
  });

  it('passes banner imageType to imageService when specified in query', async () => {
    (imageService.handleImageUpload as jest.Mock).mockResolvedValue({
      processingId: VALID_UUID,
      status: 'pending',
    });

    const response = await request(app)
      .post('/api/v1/images?imageType=banner')
      .attach('image', Buffer.from([0xff, 0xd8, 0xff, 0xdb]), {
        filename: 'test.jpg',
        contentType: 'image/jpeg',
      });

    expect(response.status).toBe(202);
    expect(imageService.handleImageUpload).toHaveBeenCalledWith(
      expect.any(Object),
      'banner'
    );
  });

  it('returns 400 when no file is attached', async () => {
    (imageService.handleImageUpload as jest.Mock).mockRejectedValue(
      new AppError(400, 'No image file provided. Use multipart field name "image".')
    );

    const response = await request(app).post('/api/v1/images');
    expect(response.status).toBe(400);
  });

  it('rejects unsupported file types at the multer layer', async () => {
    const response = await request(app)
      .post('/api/v1/images')
      .attach('image', Buffer.from('not an image'), {
        filename: 'test.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(400);
  });

  it('returns 400 for an oversized file', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1); // > 10MB default limit
    const response = await request(app)
      .post('/api/v1/images')
      .attach('image', oversized, { filename: 'big.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('LIMIT_FILE_SIZE');
  });
});

describe('GET /api/v1/images/:processingId/status', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns job status for a known processing id', async () => {
    (imageService.getJobStatus as jest.Mock).mockResolvedValue({
      processingId: VALID_UUID,
      status: 'processing',
    });

    const response = await request(app).get(`/api/v1/images/${VALID_UUID}/status`);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('processing');
  });

  it('returns 400 for a malformed processing id', async () => {
    const response = await request(app).get('/api/v1/images/not-a-uuid/status');
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown processing id', async () => {
    (imageService.getJobStatus as jest.Mock).mockRejectedValue(
      new AppError(404, `No processing job found for id ${VALID_UUID}`)
    );
    const response = await request(app).get(`/api/v1/images/${VALID_UUID}/status`);
    expect(response.status).toBe(404);
  });
});

describe('GET /api/v1/images/:processingId/results', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns completed results with checks', async () => {
    (imageService.getJobResults as jest.Mock).mockResolvedValue({
      processingId: VALID_UUID,
      imageId: 'img-123',
      status: 'completed',
      overallStatus: 'usable',
      confidence: 0.9,
      originalName: 'test.jpg',
      mimeType: 'image/jpeg',
      fileSizeBytes: 1024,
      width: 800,
      height: 600,
      imageType: 'generic',
      ocrText: null,
      checks: { blur: { status: 'pass', score: 0.9, message: 'Image sharpness is acceptable' } },
      createdAt: new Date().toISOString(),
    });

    const response = await request(app).get(`/api/v1/images/${VALID_UUID}/results`);
    expect(response.status).toBe(200);
    expect(response.body.overallStatus).toBe('usable');
    expect(response.body.checks.blur.status).toBe('pass');
    expect(response.body.imageType).toBe('generic');
    expect(response.body.ocrText).toBeNull();
  });

  it('returns 404 for an unknown processing id', async () => {
    (imageService.getJobResults as jest.Mock).mockRejectedValue(
      new AppError(404, `No processing job found for id ${VALID_UUID}`)
    );
    const response = await request(app).get(`/api/v1/images/${VALID_UUID}/results`);
    expect(response.status).toBe(404);
  });
});

describe('GET /health', () => {
  it('returns 200 ok when DB is reachable', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});
