-- VPR rating history migration for MySQL 8.x
-- Run after migration-full-fidelity-mysql8.sql.
-- Change USE vpr if your database has a different name.
USE vpr;

CREATE TABLE IF NOT EXISTS rating_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  po_id INT NOT NULL,
  category VARCHAR(20) NOT NULL,
  period VARCHAR(2) NOT NULL,
  parameter_code VARCHAR(20) NOT NULL,
  version_no INT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  old_score DECIMAL(5,2) NULL,
  new_score DECIMAL(5,2) NULL,
  old_status VARCHAR(20) NULL,
  new_status VARCHAR(20) NULL,
  actor_id INT NULL,
  actor_role VARCHAR(20) NULL,
  actor_name VARCHAR(255) NULL,
  reason TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rating_history_block (po_id, category, period, created_at),
  INDEX idx_rating_history_version (po_id, category, period, version_no),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES evaluators(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Capture each currently stored rating as a one-time baseline event.
INSERT INTO rating_history
  (po_id, category, period, parameter_code, version_no, event_type,
   old_score, new_score, old_status, new_status, actor_id, actor_role, actor_name, reason)
SELECT r.po_id, r.category, r.period, r.parameter_code, 1, 'BASELINE_IMPORTED',
       NULL, COALESCE(r.final_score, r.approver_score, r.evaluator_score, r.score),
       NULL, r.approval_status, r.evaluator_id, 'evaluator', e.name,
       'Initial baseline captured during rating-history migration'
FROM ratings r
LEFT JOIN evaluators e ON e.id = r.evaluator_id
WHERE NOT EXISTS (
  SELECT 1 FROM rating_history h
  WHERE h.po_id = r.po_id AND h.category = r.category AND h.period = r.period
    AND h.parameter_code = r.parameter_code AND h.event_type = 'BASELINE_IMPORTED'
);

SELECT COUNT(*) AS history_rows FROM rating_history;
