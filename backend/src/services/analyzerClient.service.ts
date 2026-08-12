import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { env } from '../config/env';

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
  const form = new FormData();
  form.append('file', fs.createReadStream(absoluteFilePath), {
    contentType: mimeType,
  });
  if (imageType) {
    form.append('image_type', imageType);
  }

  const response = await client.post<AnalyzerResponse>('/analyze', form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return response.data;
}
