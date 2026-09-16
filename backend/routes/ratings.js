const express = require('express');
const router = express.Router();
const pool = require('../db');
const { canApprove, canEditRatingValue, canSetNA, canResetToPending } = require('../middleware/auth');

async function recordHistory({ po_id, category, period, parameter_code, version_no, event_type, old_score, new_score, old_status, new_status, actor, reason }) {
  await pool.query(
    `INSERT INTO rating_history
      (po_id, category, period, parameter_code, version_no, event_type,
       old_score, new_score, old_status, new_status, actor_id, actor_role, actor_name, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [po_id, category, period, parameter_code, version_no, event_type,
      old_score ?? null, new_score ?? null, old_status ?? null, new_status ?? null,
      actor?.id ?? null, actor?.role ?? null, actor?.name ?? null, reason || null]
  );
}

// GET /api/ratings?po_id=&category=&period=
router.get('/', async (req, res) => {
  const { po_id, category, period } = req.query;
  const clauses = [];
  const values = [];
  if (po_id) { clauses.push('r.po_id = ?'); values.push(po_id); }
  if (category) { clauses.push('r.category = ?'); values.push(category); }
  if (period) { clauses.push('r.period = ?'); values.push(period); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const [rows] = await pool.query(
      `SELECT r.*, e.name AS evaluator_name, a.name AS approver_name,
              po.po_number AS po_number
       FROM ratings r
       LEFT JOIN evaluators e ON e.id = r.evaluator_id
       LEFT JOIN evaluators a ON a.id = r.approver_id
       LEFT JOIN purchase_orders po ON po.id = r.po_id
       ${where}
       ORDER BY r.updated_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

// GET /api/ratings/history?po_id=&category=&period=
// Internal-only immutable change history. Vendor-facing APIs must not expose this.
router.get('/history', async (req, res) => {
  const { po_id, category, period } = req.query;
  if (!po_id || !category || !period) return res.status(400).json({ error: 'po_id, category and period are required' });
  try {
    const [rows] = await pool.query(
      `SELECT h.*, COALESCE(h.actor_name, e.name) AS actor_display_name
       FROM rating_history h LEFT JOIN evaluators e ON e.id = h.actor_id
       WHERE h.po_id = ? AND h.category = ? AND h.period = ?
       ORDER BY h.created_at DESC, h.id DESC`,
      [po_id, category, period]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rating history' });
  }
});

// Workbook imports store parameter_code as A1/B3/C11/D10. The live UI saves
// scm_0 / edrc_2 / quality_10 / operation_9. Both refer to the same star cell.
// Without alias resolution, a Save creates a second row and hydration can
// prefer the stale imported score over the new one.
const CAT_TO_LETTER = { scm: 'A', edrc: 'B', quality: 'C', operation: 'D' };
const LETTER_TO_CAT = { A: 'scm', B: 'edrc', C: 'quality', D: 'operation' };

function parameterCodeAliases(category, parameter_code) {
  const raw = String(parameter_code || '').trim();
  const aliases = new Set([raw]);
  const internal = raw.match(/^(scm|edrc|quality|operation)_(\d+)$/i);
  if (internal) {
    const letter = CAT_TO_LETTER[internal[1].toLowerCase()];
    if (letter) aliases.add(`${letter}${Number(internal[2]) + 1}`);
    aliases.add(`${internal[1].toLowerCase()}_${Number(internal[2])}`);
  }
  const workbook = raw.match(/^([A-D])(\d+)$/i);
  if (workbook) {
    const cat = LETTER_TO_CAT[workbook[1].toUpperCase()];
    const idx = Number(workbook[2]) - 1;
    if (cat && idx >= 0) aliases.add(`${cat}_${idx}`);
    aliases.add(`${workbook[1].toUpperCase()}${Number(workbook[2])}`);
  }
  // Also try the category-implied workbook letter when the UI only sent scm_N.
  const catLetter = CAT_TO_LETTER[String(category || '').toLowerCase()];
  if (catLetter && internal) aliases.add(`${catLetter}${Number(internal[2]) + 1}`);
  return [...aliases];
}

// POST /api/ratings — create or update a single parameter's rating (upsert).
// The evaluator is whoever the Bearer token belongs to — never trust a
// client-supplied name for this.
// Body: { po_id, category, period, parameter_code, score, status, remarks, change_reason }
router.post('/', async (req, res) => {
  const { po_id, category, period, parameter_code, score, status, remarks, change_reason } = req.body;
  if (!po_id || !category || !period || !parameter_code) {
    return res.status(400).json({ error: 'po_id, category, period and parameter_code are required' });
  }

  try {
    if (!(await canEditRatingValue(pool, req.user, po_id, category, period))) {
      return res.status(403).json({ error: `Not authorized to rate ${category} parameters for this PO` });
    }

    // Resolve any existing row under an alias code (A1 ↔ scm_0) so we update
    // in place instead of inserting a duplicate that fights the old score.
    const aliases = parameterCodeAliases(category, parameter_code);
    const [aliasRows] = await pool.query(
      `SELECT id, parameter_code, evaluator_id, approver_id, score, status, version_no, approval_status, change_reason
       FROM ratings
       WHERE po_id=? AND category=? AND period=? AND parameter_code IN (${aliases.map(() => '?').join(',')})
       ORDER BY updated_at DESC, id DESC`,
      [po_id, category, period, ...aliases]
    );
    const existing = aliasRows[0] || null;
    // Canonical code written going forward is the UI form (scm_0). If we found
    // an imported A1 row, rename it on update so future lookups stay unique.
    const canonicalCode = (() => {
      const m = String(parameter_code).match(/^(scm|edrc|quality|operation)_(\d+)$/i);
      if (m) return `${m[1].toLowerCase()}_${Number(m[2])}`;
      const w = String(parameter_code).match(/^([A-D])(\d+)$/i);
      if (w) {
        const cat = LETTER_TO_CAT[w[1].toUpperCase()];
        if (cat) return `${cat}_${Number(w[2]) - 1}`;
      }
      return parameter_code;
    })();

    // Keep attribution honest: an approver correcting a rejected rating must
    // not silently steal credit as "the evaluator" (and vice versa) — only
    // overwrite the id column for the role the current user actually holds.
    const evaluator_id = req.user.role === 'evaluator' ? req.user.id : (existing ? existing.evaluator_id : null);
    const approver_id = req.user.role === 'approver' ? req.user.id : (existing ? existing.approver_id : null);
    const isApproverCorrection = req.user.role === 'approver';
    const reason = change_reason || existing?.change_reason || null;
    const nextVersion = existing ? (existing.version_no || 1) + 1 : 1;

    // When an evaluator revises a parameter after an approver has already
    // scored/corrected it, the previous approver_score (and final_score) must
    // be cleared. Otherwise the frontend still prefers the stale approver
    // value and the approver sees "rating changed" / resubmitted status but
    // the stars keep showing the old number.
    const evaluatorScoreVal = isApproverCorrection ? null : (score ?? null);
    const approverScoreVal  = isApproverCorrection ? (score ?? null) : null;
    const finalScoreVal     = isApproverCorrection ? (score ?? null) : null;

    if (existing) {
      // Drop any other alias duplicates so only one row remains per parameter.
      if (aliasRows.length > 1) {
        const dropIds = aliasRows.slice(1).map(r => r.id);
        await pool.query(`DELETE FROM ratings WHERE id IN (${dropIds.map(() => '?').join(',')})`, dropIds);
      }
      await pool.query(
        `UPDATE ratings SET
           parameter_code = ?,
           score = ?, status = ?,
           evaluator_score = IF(? IS NOT NULL, ?, evaluator_score),
           approver_score = ?,
           final_score = ?,
           evaluator_id = ?, approver_id = ?, remarks = COALESCE(?, remarks),
           version_no = ?, change_reason = COALESCE(?, change_reason),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [canonicalCode, score ?? null, status || 'rated',
          evaluatorScoreVal, evaluatorScoreVal,
          approverScoreVal, finalScoreVal,
          evaluator_id, approver_id, remarks || null,
          nextVersion, reason, existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO ratings
          (po_id, category, period, parameter_code, score, evaluator_score, approver_score,
           final_score, status, evaluator_id, approver_id, remarks, version_no, change_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [po_id, category, period, canonicalCode, score ?? null,
          evaluatorScoreVal, approverScoreVal, finalScoreVal,
          status || 'rated', evaluator_id, approver_id, remarks || null, nextVersion, reason]
      );
    }

    // An evaluator revising any parameter always sends the whole block back
    // for review. A prior Approved/Rejected/NA decision must never continue
    // to represent values that changed after that decision.
    // Also clear any leftover approver/final scores on sibling parameters in
    // the same block so the UI cannot keep showing a mix of old approver
    // numbers and new evaluator numbers for one category.
    if (req.user.role === 'evaluator') {
      await pool.query(
        `UPDATE ratings
           SET approval_status = 'resubmitted',
               approver_score = NULL,
               final_score = NULL,
               updated_at = CURRENT_TIMESTAMP
         WHERE po_id = ? AND category = ? AND period = ?`,
        [po_id, category, period]
      );
    }

    await recordHistory({
      po_id, category, period, parameter_code: canonicalCode, version_no: nextVersion,
      event_type: req.user.role === 'approver' ? 'APPROVER_CHANGED_RATING' : 'EVALUATOR_CHANGED_RATING',
      old_score: existing?.score, new_score: score, old_status: existing?.approval_status,
      new_status: req.user.role === 'approver' ? 'rejected' : 'resubmitted',
      actor: req.user, reason: change_reason || existing?.change_reason,
    });

    const [[rating]] = await pool.query(
      `SELECT * FROM ratings WHERE po_id=? AND category=? AND period=? AND parameter_code=?`,
      [po_id, category, period, canonicalCode]
    );
    res.status(201).json(rating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save rating' });
  }
});

// POST /api/ratings/remark — set one shared "overall remarks" note for an
// entire category+period block on a PO. Applies to every existing rating
// row in that block (so it shows up no matter which parameter row the
// frontend happens to read `remarks` off of), and seeds a placeholder row
// when nothing has been rated yet, same convention as /approve below.
// Gated by the same rule as writing a score (canEditRatingValue) — remarks
// travel with the same edit lifecycle as the ratings they annotate.
// Body: { po_id, category, period, remarks }
router.post('/remark', async (req, res) => {
  const { po_id, category, period, remarks } = req.body;
  if (!po_id || !category || !period) {
    return res.status(400).json({ error: 'po_id, category and period are required' });
  }

  try {
    if (!(await canEditRatingValue(pool, req.user, po_id, category, period))) {
      return res.status(403).json({ error: `Not authorized to add remarks for ${category} on this PO` });
    }

    const [result] = await pool.query(
      `UPDATE ratings SET remarks = ?, updated_at = CURRENT_TIMESTAMP
       WHERE po_id = ? AND category = ? AND period = ?`,
      [remarks || null, po_id, category, period]
    );

    if (result.affectedRows === 0) {
      await pool.query(
        `INSERT INTO ratings (po_id, category, period, parameter_code, status, remarks)
         VALUES (?, ?, ?, '_status', 'pending', ?)
         ON DUPLICATE KEY UPDATE remarks = VALUES(remarks), updated_at = CURRENT_TIMESTAMP`,
        [po_id, category, period, remarks || null]
      );
    }

    // Remarks are part of the evaluator's submission too. Changing one
    // reopens the block so the approver reviews the revised context as well
    // as the parameter values.
    if (req.user.role === 'evaluator') {
      await pool.query(
        `UPDATE ratings SET approval_status = 'resubmitted', updated_at = CURRENT_TIMESTAMP
         WHERE po_id = ? AND category = ? AND period = ?`,
        [po_id, category, period]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save remark' });
  }
});

// Both approve endpoints below accept these decisions:
//   'approved' | 'rejected' ("Not Approved and Changed") — approver/admin only
//   'na'       ("Not Applicable")                        — evaluator, approver, or admin
//   'pending'  (reopen an NA block)                       — evaluator/admin only
// A non-'na' decision also stamps approver_id; 'na' set by an evaluator must
// not credit them as the approver, since they haven't approved anything.
const DECISIONS = ['approved', 'rejected', 'na', 'pending'];

async function authorizeDecision(pool, user, po_id, category, period, decision) {
  if (decision === 'na') return canSetNA(pool, user, po_id, category, period);
  if (decision === 'pending') return canResetToPending(pool, user, po_id, category, period);
  return canApprove(pool, user, po_id, category, period);
}

// PATCH /api/ratings/:id/approve — set one rating row's status.
// Body: { decision: 'approved' | 'rejected' | 'na' | 'pending' }
router.patch('/:id/approve', async (req, res) => {
  const { decision } = req.body;
  if (!DECISIONS.includes(decision)) {
      return res.status(400).json({ error: "decision ('approved', 'rejected', 'na' or 'pending') is required" });
  }

  try {
    const [[existing]] = await pool.query('SELECT po_id, category, period FROM ratings WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Rating not found' });

    if (!(await authorizeDecision(pool, req.user, existing.po_id, existing.category, existing.period, decision))) {
      return res.status(403).json({ error: `You're not authorized to set this status for ${existing.category} on this PO` });
    }

    const isPending = decision === 'pending';
    const storedDecision = isPending ? 'resubmitted' : decision;
    const stampApprover = !isPending && (decision !== 'na' || req.user.role === 'approver' || req.user.role === 'admin');
    await pool.query(
      stampApprover
        ? `UPDATE ratings SET approver_id = ?, approval_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        : isPending
          ? `UPDATE ratings SET approval_status = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          : `UPDATE ratings SET approval_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      stampApprover ? [req.user.id, storedDecision, req.params.id] : [storedDecision, req.params.id]
    );

    const [[rating]] = await pool.query('SELECT * FROM ratings WHERE id = ?', [req.params.id]);
    res.json(rating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update approval' });
  }
});

// POST /api/ratings/approve — set every rated parameter's status in one
// category, for one PO and period, in a single action.
// Body: { po_id, category, period, decision: 'approved' | 'rejected' | 'na' | 'pending', change_reason }
router.post('/approve', async (req, res) => {
  const { po_id, category, period, decision, change_reason } = req.body;
  if (!po_id || !category || !period || !DECISIONS.includes(decision)) {
    return res.status(400).json({ error: "po_id, category, period and decision ('approved'|'rejected'|'na'|'pending') are required" });
  }

  try {
    if (!(await authorizeDecision(pool, req.user, po_id, category, period, decision))) {
      return res.status(403).json({ error: `You're not authorized to set this status for ${category} on this PO` });
    }
    if (decision === 'rejected' && (req.user.role === 'approver' || req.user.role === 'admin') && !String(change_reason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when the approver changes the evaluator\'s rating' });
    }

    // Only stamp approver_id for an actual approve/reject decision, or when
    // an approver/admin is the one setting 'na' — an evaluator marking NA
    // hasn't approved anything and must not be credited as the approver.
    const isPending = decision === 'pending';
    const storedDecision = isPending ? 'resubmitted' : decision;
    const stampApprover = !isPending && (decision !== 'na' || req.user.role === 'approver' || req.user.role === 'admin');

    // A block nobody has scored yet has no rating rows for the UPDATE below
    // to touch — the common case for 'na' ("nothing here to rate at all"),
    // but possible for approved/rejected too. Seed one placeholder row so
    // the status still sticks and the frontend's hydration (which reads
    // status off real rows) can see it. parameter_code '_status'
    // deliberately can't match any real parameter's code pattern, so it
    // never shows up as a scored parameter or inflates fill counts.
    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM ratings WHERE po_id = ? AND category = ? AND period = ?',
      [po_id, category, period]
    );
    if (cnt === 0) {
      await pool.query(
        `INSERT INTO ratings (po_id, category, period, parameter_code, status, evaluator_id, approver_id, approval_status)
         VALUES (?, ?, ?, '_status', 'pending', ?, ?, 'awaiting')`,
        [po_id, category, period,
          req.user.role === 'evaluator' ? req.user.id : null,
          (req.user.role === 'approver' || req.user.role === 'admin') ? req.user.id : null]
      );
    }

    const [result] = await pool.query(
      stampApprover
        ? `UPDATE ratings SET approver_id = ?, approval_status = ?, change_reason = COALESCE(?, change_reason), updated_at = CURRENT_TIMESTAMP
           WHERE po_id = ? AND category = ? AND period = ?`
        : isPending
          ? `UPDATE ratings SET approval_status = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP
             WHERE po_id = ? AND category = ? AND period = ?`
          : `UPDATE ratings SET approval_status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE po_id = ? AND category = ? AND period = ?`,
      stampApprover ? [req.user.id, storedDecision, change_reason || null, po_id, category, period] : [storedDecision, po_id, category, period]
    );
    if (decision === 'rejected') {
      const [changedRows] = await pool.query(
        `SELECT parameter_code, score, status, version_no FROM ratings
         WHERE po_id = ? AND category = ? AND period = ?`,
        [po_id, category, period]
      );
      for (const row of changedRows) {
        await recordHistory({
          po_id, category, period, parameter_code: row.parameter_code,
          version_no: row.version_no || 1, event_type: 'APPROVER_MARKED_NOT_APPROVED_AND_CHANGED',
          old_score: row.score, new_score: row.score, old_status: 'awaiting', new_status: 'rejected',
          actor: req.user, reason: change_reason,
        });
      }
    }
    res.json({ ratings_updated: result.affectedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk approve ratings' });
  }
});

module.exports = router;
