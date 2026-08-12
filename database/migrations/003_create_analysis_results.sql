-- 003_create_analysis_results.sql
CREATE TABLE IF NOT EXISTS analysis_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
    check_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pass', 'warning', 'fail')),
    score NUMERIC(5,3),
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, check_type)
);

CREATE INDEX IF NOT EXISTS idx_analysis_results_job_id ON analysis_results (job_id);
CREATE INDEX IF NOT EXISTS idx_analysis_results_check_type ON analysis_results (check_type);
