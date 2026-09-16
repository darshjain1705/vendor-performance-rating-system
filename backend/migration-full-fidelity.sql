-- Full-fidelity Excel migration patch.
-- Run this after schema.sql and before migrate-excel.js.
-- Safe for an existing database: all additions are nullable and retain the
-- existing ratings.score/status/approval_status columns used by the API.

ALTER TABLE ratings
  ADD COLUMN IF NOT EXISTS item VARCHAR(255) NULL AFTER period,
  ADD COLUMN IF NOT EXISTS evaluator_score DECIMAL(5,2) NULL AFTER score,
  ADD COLUMN IF NOT EXISTS approver_score DECIMAL(5,2) NULL AFTER evaluator_score,
  ADD COLUMN IF NOT EXISTS final_score DECIMAL(5,2) NULL AFTER approver_score,
  ADD COLUMN IF NOT EXISTS source_status VARCHAR(50) NULL AFTER approval_status;

CREATE INDEX idx_ratings_source ON ratings (category, period, source_status);

ALTER TABLE ratings
  ADD COLUMN IF NOT EXISTS version_no INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS change_reason TEXT NULL;
