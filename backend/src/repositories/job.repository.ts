import { pool } from '../config/db';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type OverallStatus = 'usable' | 'review' | 'rejected';

export interface JobRecord {
  id: string;
  image_id: string;
  status: JobStatus;
  overall_status: OverallStatus | null;
  confidence: string | null;
  attempts: number;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export async function createJob(imageId: string): Promise<JobRecord> {
  const result = await pool.query<JobRecord>(
    `INSERT INTO processing_jobs (image_id, status)
     VALUES ($1, 'pending')
     RETURNING *`,
    [imageId]
  );
  return result.rows[0];
}

export async function findJobById(jobId: string): Promise<JobRecord | null> {
  const result = await pool.query<JobRecord>('SELECT * FROM processing_jobs WHERE id = $1', [jobId]);
  return result.rows[0] ?? null;
}

export async function markJobProcessing(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE processing_jobs
     SET status = 'processing', started_at = now(), attempts = attempts + 1
     WHERE id = $1`,
    [jobId]
  );
}

export async function markJobCompleted(
  jobId: string,
  overallStatus: OverallStatus,
  confidence: number
): Promise<void> {
  await pool.query(
    `UPDATE processing_jobs
     SET status = 'completed', overall_status = $2, confidence = $3, completed_at = now(), error_message = NULL
     WHERE id = $1`,
    [jobId, overallStatus, confidence]
  );
}

export async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE processing_jobs
     SET status = 'failed', error_message = $2, completed_at = now()
     WHERE id = $1`,
    [jobId, errorMessage]
  );
}

export async function resetJobToPending(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE processing_jobs SET status = 'pending', started_at = NULL WHERE id = $1`,
    [jobId]
  );
}
