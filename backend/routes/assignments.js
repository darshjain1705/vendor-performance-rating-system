const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/assignments?po_id=&category=&period=
router.get('/', async (req, res) => {
  const { po_id, category, period } = req.query;
  const clauses = [];
  const values = [];
  if (po_id) { clauses.push('a.po_id = ?'); values.push(po_id); }
  if (category) { clauses.push('a.category = ?'); values.push(category); }
  if (period) { clauses.push('a.period = ?'); values.push(period); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const [rows] = await pool.query(
      `SELECT a.*, ev.name AS evaluator_name, ap.name AS approver_name
       FROM po_assignments a
       LEFT JOIN evaluators ev ON ev.id = a.evaluator_id
       LEFT JOIN evaluators ap ON ap.id = a.approver_id
       ${where}`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// POST /api/assignments — admin only: pin a specific evaluator/approver to
// one PO's rating block for one category+period. Pass null (or omit) for
// either id to leave that role open to the whole team.
// Body: { po_id, category, period, evaluator_id, approver_id }
router.post('/', requireAdmin, async (req, res) => {
  const { po_id, category, period, evaluator_id, approver_id } = req.body;
  if (!po_id || !category || !period) {
    return res.status(400).json({ error: 'po_id, category and period are required' });
  }

  try {
    await pool.query(
      `INSERT INTO po_assignments (po_id, category, period, evaluator_id, approver_id)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE evaluator_id = VALUES(evaluator_id), approver_id = VALUES(approver_id)`,
      [po_id, category, period, evaluator_id || null, approver_id || null]
    );
    const [[assignment]] = await pool.query(
      'SELECT * FROM po_assignments WHERE po_id = ? AND category = ? AND period = ?',
      [po_id, category, period]
    );
    res.status(201).json(assignment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save assignment' });
  }
});

module.exports = router;
