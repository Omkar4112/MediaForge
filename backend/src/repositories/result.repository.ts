import { pool } from '../config/db';
import { CheckStatus } from '../services/analyzerClient.service';

export interface AnalysisResultRecord {
  id: string;
  job_id: string;
  check_type: string;
  status: CheckStatus;
  score: string | null;
  result: Record<string, unknown>;
  created_at: Date;
}

export interface UpsertResultInput {
  jobId: string;
  checkType: string;
  status: CheckStatus;
  score: number | null;
  result: Record<string, unknown>;
}

export async function upsertAnalysisResult(input: UpsertResultInput): Promise<AnalysisResultRecord> {
  const result = await pool.query<AnalysisResultRecord>(
    `INSERT INTO analysis_results (job_id, check_type, status, score, result)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id, check_type)
     DO UPDATE SET status = EXCLUDED.status, score = EXCLUDED.score, result = EXCLUDED.result
     RETURNING *`,
    [input.jobId, input.checkType, input.status, input.score, JSON.stringify(input.result)]
  );
  return result.rows[0];
}

export async function findResultsByJobId(jobId: string): Promise<AnalysisResultRecord[]> {
  const result = await pool.query<AnalysisResultRecord>(
    'SELECT * FROM analysis_results WHERE job_id = $1 ORDER BY created_at ASC',
    [jobId]
  );
  return result.rows;
}

export async function deleteResultsByJobId(jobId: string): Promise<void> {
  await pool.query('DELETE FROM analysis_results WHERE job_id = $1', [jobId]);
}
