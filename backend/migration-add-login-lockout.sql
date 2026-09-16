-- Adds account-lockout tracking to the evaluators table without touching
-- existing data. Only needed if your database already has the evaluators
-- table from an earlier run of schema.sql — if you haven't created the
-- database yet, just run the current schema.sql instead, these columns are
-- already included in it.
--
--   mysql -u root -p vpr < migration-add-login-lockout.sql

ALTER TABLE evaluators
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0 AFTER team,
  ADD COLUMN IF NOT EXISTS locked_until DATETIME NULL AFTER failed_login_attempts;
