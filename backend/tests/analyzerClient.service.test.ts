import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Mock fs to avoid reading files during test
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue(Buffer.from('dummy-image-content')),
}));

const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
};

// Mock axios.create to return our mock instance
jest.mock('axios', () => {
  return {
    create: jest.fn(() => mockAxiosInstance),
  };
});

// Mock logger to avoid polluting test output
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  checkAnalyzerHealthDirect,
  wakeAnalyzer,
  analyzeImage,
} from '../src/services/analyzerClient.service';

describe('analyzerClient.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkAnalyzerHealthDirect', () => {
    it('returns true when health status is ok and 200', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { status: 'ok' },
      });

      const result = await checkAnalyzerHealthDirect();
      expect(result).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/health', { timeout: 3000 });
    });

    it('returns false when health status is not 200', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 500,
        data: { status: 'error' },
      });

      const result = await checkAnalyzerHealthDirect();
      expect(result).toBe(false);
    });

    it('returns false when request throws an error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await checkAnalyzerHealthDirect();
      expect(result).toBe(false);
    });
  });

  describe('wakeAnalyzer', () => {
    it('succeeds immediately if first call returns 200 ok', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { status: 'ok' },
      });

      await expect(wakeAnalyzer()).resolves.not.toThrow();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it('retries on 502/503/504 and eventually succeeds', async () => {
      const mockError = {
        response: { status: 502, data: 'Bad Gateway' },
        config: { method: 'GET', url: '/health' },
        message: 'Request failed with status code 502',
      };
      
      mockAxiosInstance.get
        .mockRejectedValueOnce(mockError)
        .mockRejectedValueOnce({
          response: { status: 503, data: 'Service Unavailable' },
          config: { method: 'GET', url: '/health' },
          message: 'Request failed with status code 503',
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { status: 'ok' },
        });

      // Use fake timers to speed up tests that setTimeout
      jest.useFakeTimers();
      
      const wakePromise = wakeAnalyzer();
      
      // Fast-forward through first retry delay (5s)
      await jest.advanceTimersByTimeAsync(5000);
      // Fast-forward through second retry delay (5s)
      await jest.advanceTimersByTimeAsync(5000);

      await expect(wakePromise).resolves.not.toThrow();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
      
      jest.useRealTimers();
    });

    it('handles 429 using Retry-After header when present', async () => {
      const mock429Error = {
        response: {
          status: 429,
          headers: { 'retry-after': '10' }, // wait 10 seconds
          data: 'Too Many Requests',
        },
        config: { method: 'GET', url: '/health' },
        message: 'Request failed with status code 429',
      };

      mockAxiosInstance.get
        .mockRejectedValueOnce(mock429Error)
        .mockResolvedValueOnce({
          status: 200,
          data: { status: 'ok' },
        });

      jest.useFakeTimers();

      const wakePromise = wakeAnalyzer();

      // Advancing less than 10s should not trigger the second request
      await jest.advanceTimersByTimeAsync(5000);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);

      // Advance to full 10s
      await jest.advanceTimersByTimeAsync(5000);

      await expect(wakePromise).resolves.not.toThrow();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('fails after exhausting maximum retry attempts', async () => {
      const mockError = {
        response: { status: 502, data: 'Bad Gateway' },
        config: { method: 'GET', url: '/health' },
        message: 'Request failed with status code 502',
      };

      // Fill with 30 mock rejections
      for (let i = 0; i < 30; i++) {
        mockAxiosInstance.get.mockRejectedValueOnce(mockError);
      }

      jest.useFakeTimers();

      const wakePromise = wakeAnalyzer();
      // Catch to prevent unhandled rejection warnings in Node
      wakePromise.catch(() => {});

      // Advance timers 30 times
      for (let i = 0; i < 30; i++) {
        await jest.advanceTimersByTimeAsync(5000);
      }

      await expect(wakePromise).rejects.toThrow('Analyzer failed to wake up after maximum retry attempts');
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(30);

      jest.useRealTimers();
    });
  });

  describe('analyzeImage', () => {
    const mockSuccessResponse = {
      status: 200,
      data: {
        blur: { status: 'pass' },
        brightness: { status: 'pass' },
        ocr: { status: 'pass' },
        numberPlate: { status: 'pass' },
        dimensions: { status: 'pass' },
        photoOfPhoto: { status: 'pass' },
        tampering: { status: 'pass' },
        phash: 'xyz789',
      },
    };

    it('successfully posts file after waking analyzer', async () => {
      // 1. wakeAnalyzer GET /health call mock
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { status: 'ok' },
      });

      // 2. analyzeImage POST /analyze call mock
      mockAxiosInstance.post.mockResolvedValueOnce(mockSuccessResponse);

      const result = await analyzeImage('dummy_path.jpg', 'image/jpeg', 'vehicle');
      expect(result.phash).toBe('xyz789');
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
    });

    it('retries POST /analyze on transient errors and eventually succeeds', async () => {
      // 1. wakeAnalyzer GET /health call mock
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { status: 'ok' },
      });

      // 2. analyzeImage POST /analyze calls mock
      const mockPostError = {
        response: { status: 502, data: 'Bad Gateway' },
        config: { method: 'POST', url: '/analyze' },
        message: 'Request failed with status code 502',
      };

      mockAxiosInstance.post
        .mockRejectedValueOnce(mockPostError)
        .mockResolvedValueOnce(mockSuccessResponse);

      jest.useFakeTimers();

      const analyzePromise = analyzeImage('dummy_path.jpg', 'image/jpeg');

      // Advance by post retry delay (3s)
      await jest.advanceTimersByTimeAsync(3000);

      const result = await analyzePromise;
      expect(result.phash).toBe('xyz789');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });
  });
});
