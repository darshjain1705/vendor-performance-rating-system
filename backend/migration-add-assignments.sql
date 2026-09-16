-- Adds PO assignment support without touching existing data.
-- Only needed if your database already has the vendors/purchase_orders/
-- evaluators/ratings tables from an earlier run of schema.sql — if you
-- haven't created the database yet, just run the current schema.sql
-- instead, this table is already included in it.
--
--   mysql -u root -p vpr < migration-add-assignments.sql

CREATE TABLE IF NOT EXISTS po_assignments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  po_id         INT NOT NULL,
  category      VARCHAR(20) NOT NULL,
  period        VARCHAR(2)  NOT NULL,
  evaluator_id  INT,
  approver_id   INT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_assignment (po_id, category, period),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluator_id) REFERENCES evaluators(id),
  FOREIGN KEY (approver_id) REFERENCES evaluators(id)
) ENGINE=InnoDB;
