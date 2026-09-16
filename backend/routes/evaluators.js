const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/evaluators/login-activity — admin-only successful login history.
router.get('/login-activity', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, name, role, team, last_login_at
       FROM evaluators WHERE last_login_at IS NOT NULL
       ORDER BY last_login_at DESC, name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch login activity' });
  }
});

// GET /api/evaluators?role=evaluator|approver
router.get('/', async (req, res) => {
  const { role } = req.query;
  try {
    const [rows] = role
      ? await pool.query('SELECT id, username, name, role, team FROM evaluators WHERE role = ? ORDER BY name', [role])
      : await pool.query('SELECT id, username, name, role, team FROM evaluators ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch evaluators' });
  }
});

// POST /api/evaluators — admin only: create or update a login account.
// Body: { username, password, name, role: 'admin'|'evaluator'|'approver', team }
router.post('/', requireAdmin, async (req, res) => {
  const { username, password, name, role, team } = req.body;
  if (!username || !password || !name || !['admin', 'evaluator', 'approver'].includes(role)) {
    return res.status(400).json({ error: "username, password, name and role ('admin'|'evaluator'|'approver') are required" });
  }
  if (role !== 'admin' && !team) {
    return res.status(400).json({ error: 'team is required for evaluator/approver accounts' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);
    // Setting/resetting a password also clears any lockout — an admin doing
    // this for an existing account is almost always fixing a locked-out
    // user, and there's no reason to make them separately un-stick it.
    await pool.query(
      `INSERT INTO evaluators (username, password_hash, name, role, team) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), name = VALUES(name), role = VALUES(role), team = VALUES(team),
         failed_login_attempts = 0, locked_until = NULL`,
      [username, password_hash, name, role, team || null]
    );
    const [[evaluator]] = await pool.query(
      'SELECT id, username, name, role, team FROM evaluators WHERE username = ?',
      [username]
    );
    res.status(201).json(evaluator);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create evaluator account' });
  }
});

module.exports = router;
