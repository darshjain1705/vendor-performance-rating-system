-- Adds the timestamp used by the admin-only Login Activity view.
ALTER TABLE evaluators
  ADD COLUMN last_login_at DATETIME NULL AFTER locked_until;
