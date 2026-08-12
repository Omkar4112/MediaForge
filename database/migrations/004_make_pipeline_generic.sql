-- 004_make_pipeline_generic.sql
ALTER TABLE images ADD COLUMN IF NOT EXISTS image_type TEXT NOT NULL DEFAULT 'generic';

ALTER TABLE analysis_results DROP CONSTRAINT IF EXISTS analysis_results_status_check;
ALTER TABLE analysis_results ADD CONSTRAINT analysis_results_status_check CHECK (status IN ('pass', 'warning', 'fail', 'not_applicable'));
