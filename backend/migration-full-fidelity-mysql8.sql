-- Full-fidelity Excel migration patch for MySQL 8.x
-- Safe to run against an existing database.
--
-- IMPORTANT:
-- 1. Select/use the VPR database before running this script.
--    Example: USE vpr;
-- 2. This script is intentionally written without
--    "ADD COLUMN IF NOT EXISTS", because MySQL 8.x does not support
--    that MariaDB syntax.
-- 3. Each column is checked in INFORMATION_SCHEMA before being added.
-- 4. The source index is also checked before being created.
-- 5. Existing data and existing columns are preserved.

USE vpr;

-- ============================================================
-- 1. Add ratings.item only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE ratings ADD COLUMN item VARCHAR(255) NULL AFTER period',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND column_name = 'item'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 2. Add ratings.evaluator_score only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE ratings ADD COLUMN evaluator_score DECIMAL(5,2) NULL AFTER score',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND column_name = 'evaluator_score'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 3. Add ratings.approver_score only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE ratings ADD COLUMN approver_score DECIMAL(5,2) NULL AFTER evaluator_score',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND column_name = 'approver_score'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 4. Add ratings.final_score only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE ratings ADD COLUMN final_score DECIMAL(5,2) NULL AFTER approver_score',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND column_name = 'final_score'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 5. Add ratings.source_status only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE ratings ADD COLUMN source_status VARCHAR(50) NULL AFTER approval_status',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND column_name = 'source_status'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 6. Create source index only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_ratings_source ON ratings (category, period, source_status)',
    'SELECT 1'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND index_name = 'idx_ratings_source'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 7. Add ratings.version_no only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE ratings ADD COLUMN version_no INT NOT NULL DEFAULT 1',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND column_name = 'version_no'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 8. Add ratings.change_reason only when it is missing
-- ============================================================

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE ratings ADD COLUMN change_reason TEXT NULL',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'ratings'
    AND column_name = 'change_reason'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ============================================================
-- 9. Verify final structure
-- ============================================================

DESCRIBE ratings;

SHOW INDEX FROM ratings;
