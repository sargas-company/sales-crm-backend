-- Add a `job_analysis` section to UpworkChangeLogSection. Used as
-- a research sink (yearly 100-job-posts review), excluded from
-- analytics markers and the activity-by-section bar.

ALTER TYPE "UpworkChangeLogSection" ADD VALUE IF NOT EXISTS 'job_analysis';
