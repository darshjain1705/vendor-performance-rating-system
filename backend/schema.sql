-- Run this once against your database:
--   mysql -u root -p vpr < schema.sql

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS rating_history;
DROP TABLE IF EXISTS ratings;
DROP TABLE IF EXISTS po_assignments;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS evaluators;
DROP TABLE IF EXISTS vendors;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE vendors (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  code             VARCHAR(50) UNIQUE NOT NULL,   -- VENDOR CODE, e.g. V0001234
  name             VARCHAR(255) NOT NULL,         -- VENDOR DESC
  msme_tag         VARCHAR(10),                   -- VENDOR MSME TAG (Y/N)
  category         VARCHAR(50),                   -- VENDOR CATEGORY (e.g. Supplier)
  factory_location VARCHAR(255),
  address          TEXT,
  material_desc    TEXT,
  c1_name          VARCHAR(255),
  c1_email         VARCHAR(255),
  c1_phone         VARCHAR(50),
  c2_name          VARCHAR(255),
  c2_email         VARCHAR(255),
  c2_phone         VARCHAR(50),
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE purchase_orders (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  po_number            VARCHAR(100) UNIQUE NOT NULL,
  vendor_id            INT,
  job_code             VARCHAR(50),
  job_desc             TEXT,
  warehouse_code       VARCHAR(50),
  warehouse_desc       TEXT,
  po_date              DATE,
  po_status            VARCHAR(50),             -- Authorize / Pending / Cancelled ...
  po_type              VARCHAR(100),
  po_category          VARCHAR(50),
  po_value             DECIMAL(15,2),
  currency             VARCHAR(50),
  delivery_start_date  DATE,
  delivery_end_date    DATE,
  buyer                VARCHAR(255),
  bu                   VARCHAR(255),
  sbu                  VARCHAR(255),
  payment_terms        VARCHAR(255),
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id) REFERENCES vendors(id)
) ENGINE=InnoDB;

CREATE TABLE evaluators (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  username               VARCHAR(100) UNIQUE NOT NULL,
  password_hash          VARCHAR(255) NOT NULL,
  name                   VARCHAR(255) NOT NULL,
  role                   VARCHAR(20) NOT NULL,   -- 'admin' / 'evaluator' / 'approver'
  team                   VARCHAR(20),            -- scm / edrc / quality / operation (NULL for admin)
  failed_login_attempts  INT NOT NULL DEFAULT 0, -- reset to 0 on any successful login
  locked_until           DATETIME NULL,          -- NULL = not locked; set on the 5th consecutive failure
  last_login_at          DATETIME NULL,          -- successful-login activity, visible to admins
  created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE po_assignments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  po_id         INT NOT NULL,
  category      VARCHAR(20) NOT NULL,       -- scm / edrc / quality / operation
  period        VARCHAR(2)  NOT NULL,       -- H1 / H2
  evaluator_id  INT,                        -- who is allowed to rate this block (NULL = whole team)
  approver_id   INT,                        -- who is allowed to approve this block (NULL = whole team)
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_assignment (po_id, category, period),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluator_id) REFERENCES evaluators(id),
  FOREIGN KEY (approver_id) REFERENCES evaluators(id)
) ENGINE=InnoDB;

CREATE TABLE ratings (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  po_id            INT,
  category         VARCHAR(20) NOT NULL,       -- scm / edrc / quality / operation
  period           VARCHAR(2)  NOT NULL,       -- H1 / H2
  parameter_code   VARCHAR(20) NOT NULL,       -- e.g. scm_0, quality_3
  score            DECIMAL(5,2),
  status           VARCHAR(20) DEFAULT 'pending',   -- pending / rated / NA
  evaluator_id     INT,
  approver_id      INT,
  approval_status  VARCHAR(20) DEFAULT 'awaiting',  -- awaiting / approved / rejected
  remarks          TEXT,
  evaluator_score  DECIMAL(5,2) NULL,
  approver_score   DECIMAL(5,2) NULL,
  final_score      DECIMAL(5,2) NULL,
  version_no       INT NOT NULL DEFAULT 1,
  change_reason    TEXT NULL,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_rating (po_id, category, period, parameter_code),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluator_id) REFERENCES evaluators(id),
  FOREIGN KEY (approver_id) REFERENCES evaluators(id)
) ENGINE=InnoDB;

CREATE TABLE rating_history (
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
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES evaluators(id) ON DELETE SET NULL
) ENGINE=InnoDB;
