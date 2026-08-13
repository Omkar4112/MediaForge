import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export type CheckStatus = 'pass' | 'warning' | 'fail' | 'not_applicable';

export interface AnalyzerCheckResult {
  status: CheckStatus;
  score?: number | null;
  [key: string]: unknown;
}

export interface AnalyzerResponse {
  blur: AnalyzerCheckResult;
  brightness: AnalyzerCheckResult;
  ocr: AnalyzerCheckResult;
  numberPlate: AnalyzerCheckResult;
  dimensions: AnalyzerCheckResult;
  photoOfPhoto: AnalyzerCheckResult;
  tampering: AnalyzerCheckResult;
  phash: string;
}

const client = axios.create({
  baseURL: env.analyzer.baseUrl,
  timeout: env.analyzer.timeoutMs,
});

export async function analyzeImage(
  absoluteFilePath: string,
  mimeType: string,
  imageType?: string
): Promise<AnalyzerResponse> {
  const url = `${env.analyzer.baseUrl}/analyze`;
  logger.info('Sending POST request to analyzer', {
    url,
    mimeType,
    imageType,
    filePath: absoluteFilePath,
  });

  const fileBuffer = fs.readFileSync(absoluteFilePath);
  const form = new FormData();
  form.append('file', fileBuffer, {
    filename: path.basename(absoluteFilePath),
    contentType: mimeType,
  });
  if (imageType) {
    form.append('image_type', imageType);
  }

  const contentLength = form.getLengthSync();
  const headers = {
    ...form.getHeaders(),
    'Content-Length': contentLength,
  };

  try {
    const response = await client.post<AnalyzerResponse>('/analyze', form, {
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    logger.info('Received response from analyzer', {
      url,
      status: response.status,
      statusText: response.statusText,
      data: response.data,
    });

    return response.data;
  } catch (err: any) {
    const errorDetails = {
      url,
      message: err.message,
      status: err.response?.status,
      statusText: err.response?.statusText,
      responseData: err.response?.data,
    };
    logger.error('Analyzer request failed', errorDetails);
    throw err;
  }
}


