const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAdmin, canEvaluate } = require('../middleware/auth');

// PATCH /api/pos/:id/item
// Allows the SCM Evaluator (or Admin) to update the item name (item_name) for a PO.
// Requires { item_name, period } in the body.
router.patch('/:id/item', async (req, res) => {
  const poId = req.params.id;
  const { item_name, period } = req.body;
  if (!item_name || !period) return res.status(400).json({ error: 'item_name and period are required' });

  // SCM Only Rule: Must be admin or the assigned SCM evaluator
  if (req.user.role !== 'admin') {
    const isScmEvaluator = await canEvaluate(pool, req.user, poId, 'scm', period);
    if (!isScmEvaluator) {
      return res.status(403).json({ error: 'Only the assigned SCM evaluator can update the item name.' });
    }
  }

  try {
    await pool.query('UPDATE purchase_orders SET item_name = ? WHERE id = ?', [item_name, poId]);
    res.json({ success: true, item_name });
  } catch(e) {
    console.error('Failed to update PO item name:', e);
    res.status(500).json({ error: 'Failed to update item name' });
  }
});

// GET /api/pos?bu=...&vendor=...&status=...&period=H1|H2
// If period is supplied only POs that have at least one assignment for that
// half-year are returned. This keeps the dashboard vendor/PO counts scoped to
// the active rating period rather than showing the entire multi-year backlog.
router.get('/', async (req, res) => {
  const { bu, vendor, status, period } = req.query;
  const clauses = [];
  const values = [];

  if (bu) { clauses.push('p.bu = ?'); values.push(bu); }
  if (vendor) { clauses.push('v.code = ?'); values.push(vendor); }
  if (status) { clauses.push('p.po_status = ?'); values.push(status); }
  if (period && ['H1', 'H2'].includes(period.toUpperCase())) {
    clauses.push('EXISTS (SELECT 1 FROM po_assignments pa WHERE pa.po_id = p.id AND pa.period = ?)');
    values.push(period.toUpperCase());
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const [rows] = await pool.query(
      `SELECT p.*, v.code AS vendor_code, v.name AS vendor_name
       FROM purchase_orders p
       JOIN vendors v ON v.id = p.vendor_id
       ${where}
       ORDER BY p.po_date DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch purchase orders' });
  }
});

// GET /api/pos/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, v.code AS vendor_code, v.name AS vendor_name
       FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'PO not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch PO' });
  }
});

// POST /api/pos — the "Add PO" provision. Admin only: this creates real
// PO records that ratings and assignments key off of.
// Body: { po_number, vendor_code, vendor_name, job_code, job_desc, bu, sbu,
//         po_value, po_date, currency, po_status, buyer, payment_terms }
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body;
  if (!b.po_number || !b.vendor_code) {
    return res.status(400).json({ error: 'po_number and vendor_code are required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO vendors (code, name)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)`,
      [b.vendor_code, b.vendor_name || b.vendor_code]
    );
    const [[vendorRow]] = await conn.query('SELECT id FROM vendors WHERE code = ?', [b.vendor_code]);

    const [result] = await conn.query(
      `INSERT INTO purchase_orders
        (po_number, vendor_id, job_code, job_desc, po_date, po_status, po_type,
         po_category, po_value, currency, delivery_start_date, delivery_end_date,
         buyer, bu, sbu, payment_terms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.po_number, vendorRow.id, b.job_code || null, b.job_desc || null,
       b.po_date || null, b.po_status || 'Authorize', b.po_type || null,
       b.po_category || null, b.po_value || 0, b.currency || null,
       b.delivery_start_date || null, b.delivery_end_date || null,
       b.buyer || null, b.bu || null, b.sbu || null, b.payment_terms || null]
    );

    await conn.commit();
    const [[newPo]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [result.insertId]);
    res.status(201).json(newPo);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'A PO with this number already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create PO' });
  } finally {
    conn.release();
  }
});

const TEAMS = ['scm', 'edrc', 'quality', 'operation'];

function text(v) { return v == null ? '' : String(v).trim(); }

// Turn a display name into a login username: lowercase, non-alphanumerics
// collapsed to single dots, trimmed — then de-duplicated against whatever's
// already taken by trying name2, name3, ... A blank/unusable name falls back
// to "user" so it still produces something rather than an empty username.
async function uniqueUsername(conn, displayName) {
  const base = text(displayName).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'user';
  let candidate = base;
  let suffix = 1;
  // Bounded loop — a runaway collision chain would mean something else is
  // badly wrong (e.g. thousands of identical names), not worth looping forever.
  while (suffix < 1000) {
    const [[row]] = await conn.query('SELECT id FROM evaluators WHERE username = ?', [candidate]);
    if (!row) return candidate;
    suffix++;
    candidate = `${base}${suffix}`;
  }
  throw new Error(`Could not find a free username for "${displayName}"`);
}

function randomTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

// Find an existing evaluator/approver account by exact name (case-insensitive)
// within one team+role, or create one with a random temp password. Returns
// { id, created, username, tempPassword? }. accountCache avoids re-querying
// for the same name repeatedly across many rows in one upload.
async function findOrCreateAccount(conn, accountCache, name, role, team, createdAccounts) {
  const cleanName = text(name);
  if (!cleanName) return null;
  const cacheKey = `${cleanName.toLowerCase()}|${role}|${team}`;
  if (accountCache.has(cacheKey)) return accountCache.get(cacheKey);

  const [[existing]] = await conn.query(
    'SELECT id FROM evaluators WHERE role = ? AND team = ? AND LOWER(name) = LOWER(?)',
    [role, team, cleanName]
  );
  if (existing) {
    const result = { id: existing.id, created: false };
    accountCache.set(cacheKey, result);
    return result;
  }

  const username = await uniqueUsername(conn, cleanName);
  const tempPassword = randomTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, 10);
  const [insertResult] = await conn.query(
    'INSERT INTO evaluators (username, password_hash, name, role, team) VALUES (?,?,?,?,?)',
    [username, password_hash, cleanName, role, team]
  );
  const result = { id: insertResult.insertId, created: true, username, tempPassword };
  accountCache.set(cacheKey, result);
  createdAccounts.push({ name: cleanName, role, team, username, tempPassword });
  return result;
}

// POST /api/pos/bulk-import — admin only: the recurring "here's an Excel of
// new/updated POs plus who's rating each team's block" workflow. The
// frontend parses the workbook client-side (it already has the xlsx lib
// loaded for local import) and posts the extracted rows as JSON here, so
// this route never has to deal with file uploads directly.
//
// Body: { period: 'H1'|'H2', rows: [{
//   po_number, vendor_code, vendor_name, job_code, job_desc, po_value,
//   currency, po_date, delivery_start_date, delivery_end_date, buyer, bu,
//   sbu, payment_terms, po_status,
//   assignments: { scm: {evaluator, approver}, edrc: {...}, quality: {...}, operation: {...} }
// }] }
//
// Each row is independent — a bad row (missing po_number/vendor_code) is
// skipped and reported rather than failing the whole batch, since a typo in
// row 40 of 300 shouldn't block the other 299 from importing. A name with no
// matching account for that exact role+team is auto-created with a random
// temporary password, which is returned ONLY in this response — there is no
// way to recover it later, so the admin must hand it to that person now (or
// have them use "forgot password" once that exists).
router.post('/bulk-import', requireAdmin, async (req, res) => {
  const { period, rows } = req.body;
  if (!['H1', 'H2'].includes(period)) {
    return res.status(400).json({ error: "period ('H1' or 'H2') is required" });
  }
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }

  const conn = await pool.getConnection();
  const stats = { vendorsUpserted: 0, posCreated: 0, posUpdated: 0, assignmentsUpserted: 0 };
  const createdAccounts = [];
  const errors = [];
  const accountCache = new Map();

  try {
    await conn.beginTransaction();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const rowLabel = `Row ${i + 2}`; // +2: header row + 1-indexing, matches what the admin sees in Excel
      const poNumber = text(r.po_number);
      const vendorCode = text(r.vendor_code);
      if (!poNumber || !vendorCode) {
        errors.push(`${rowLabel}: skipped — PO NUMBER and VENDOR CODE are both required`);
        continue;
      }

      try {
        await conn.query(
          `INSERT INTO vendors (code, name) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE name = COALESCE(NULLIF(VALUES(name), ''), name)`,
          [vendorCode, text(r.vendor_name) || vendorCode]
        );
        const [[vendorRow]] = await conn.query('SELECT id FROM vendors WHERE code = ?', [vendorCode]);
        stats.vendorsUpserted++;

        const [[existingPo]] = await conn.query('SELECT id FROM purchase_orders WHERE po_number = ?', [poNumber]);
        // Every updatable column preserves the existing value when this
        // upload's cell is blank (COALESCE(VALUES(col), col), or the 0/NULL
        // equivalent for po_value) — a sparse re-upload (e.g. "just add
        // these new assignments") must never clobber richer data a previous
        // upload or migrate-excel.js's fuller import already set. Only a
        // genuinely non-blank cell overwrites.
        await conn.query(
          `INSERT INTO purchase_orders
            (po_number, vendor_id, job_code, job_desc, po_date, po_status, po_category,
             po_value, currency, delivery_start_date, delivery_end_date, buyer, bu, sbu, payment_terms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             vendor_id=VALUES(vendor_id),
             job_code=COALESCE(VALUES(job_code), job_code),
             job_desc=COALESCE(VALUES(job_desc), job_desc),
             po_date=COALESCE(VALUES(po_date), po_date),
             po_status=COALESCE(VALUES(po_status), po_status),
             po_category=COALESCE(VALUES(po_category), po_category),
             po_value=COALESCE(NULLIF(VALUES(po_value), 0), po_value),
             currency=COALESCE(VALUES(currency), currency),
             delivery_start_date=COALESCE(VALUES(delivery_start_date), delivery_start_date),
             delivery_end_date=COALESCE(VALUES(delivery_end_date), delivery_end_date),
             buyer=COALESCE(VALUES(buyer), buyer),
             bu=COALESCE(VALUES(bu), bu),
             sbu=COALESCE(VALUES(sbu), sbu),
             payment_terms=COALESCE(VALUES(payment_terms), payment_terms)`,
          [poNumber, vendorRow.id, text(r.job_code) || null, text(r.job_desc) || null,
            text(r.po_date) || null,
            // A brand-new PO with no status given still defaults to 'Authorize'
            // (matches POST /api/pos); an existing PO left blank here keeps
            // whatever status it already has, via the COALESCE above.
            text(r.po_status) || (existingPo ? null : 'Authorize'),
            text(r.po_category) || null,
            r.po_value || 0, text(r.currency) || null, text(r.delivery_start_date) || null,
            text(r.delivery_end_date) || null, text(r.buyer) || null, text(r.bu) || null,
            text(r.sbu) || null, text(r.payment_terms) || null]
        );
        if (existingPo) stats.posUpdated++; else stats.posCreated++;
        const [[poRow]] = await conn.query('SELECT id FROM purchase_orders WHERE po_number = ?', [poNumber]);
        const poId = poRow.id;

        const assignments = r.assignments || {};
        for (const team of TEAMS) {
          const teamAssignment = assignments[team] || {};
          const evaluatorName = text(teamAssignment.evaluator);
          const approverName = text(teamAssignment.approver);
          if (!evaluatorName && !approverName) continue;

          const evaluatorAcct = evaluatorName
            ? await findOrCreateAccount(conn, accountCache, evaluatorName, 'evaluator', team, createdAccounts)
            : null;
          const approverAcct = approverName
            ? await findOrCreateAccount(conn, accountCache, approverName, 'approver', team, createdAccounts)
            : null;

          // Preserve whichever side (evaluator/approver) this upload didn't
          // mention, instead of blanking it out — a re-upload that only
          // updates the evaluator column must not silently unassign the
          // approver a previous upload already set.
          const [[existingAssignment]] = await conn.query(
            'SELECT evaluator_id, approver_id FROM po_assignments WHERE po_id = ? AND category = ? AND period = ?',
            [poId, team, period]
          );
          const evaluatorId = evaluatorAcct ? evaluatorAcct.id : (existingAssignment ? existingAssignment.evaluator_id : null);
          const approverId = approverAcct ? approverAcct.id : (existingAssignment ? existingAssignment.approver_id : null);

          await conn.query(
            `INSERT INTO po_assignments (po_id, category, period, evaluator_id, approver_id)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE evaluator_id = VALUES(evaluator_id), approver_id = VALUES(approver_id)`,
            [poId, team, period, evaluatorId, approverId]
          );
          stats.assignmentsUpserted++;
        }
      } catch (rowErr) {
        errors.push(`${rowLabel} (PO ${poNumber}): ${rowErr.message}`);
      }
    }

    await conn.commit();
    res.status(200).json({ stats, createdAccounts, errors });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Bulk import failed: ' + err.message });
  } finally {
    conn.release();
  }
});

// PATCH /api/pos/:id — update status etc. Admin only.
router.patch('/:id', requireAdmin, async (req, res) => {
  const fields = ['po_status', 'po_value', 'buyer', 'delivery_end_date'];
  const updates = [];
  const values = [];

  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(req.params.id);
  try {
    const [result] = await pool.query(
      `UPDATE purchase_orders SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'PO not found' });
    const [[po]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    res.json(po);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update PO' });
  }
});

module.exports = router;
