const jwt = require('jsonwebtoken');

// Verifies the Bearer token and attaches the payload as req.user:
// { id, username, name, role, team }
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Whether `user` may submit a rating for this po/category/period.
// Rules:
//   - Admin: always.
//   - Must be an evaluator on this category's team.
//   - An assignment row must exist for this po/category/period.
//   - If assignment.evaluator_id is set, only that person may rate.
//   - If assignment.evaluator_id is NULL ("whole team"), any evaluator on
//     that team may rate. This matches Assign PO's "whole team" option.
// No assignment row at all → nobody but admin.
async function canEvaluate(pool, user, po_id, category, period) {
  if (user.role === 'admin') return true;
  if (user.role !== 'evaluator' || user.team !== category) return false;

  const [[assignment]] = await pool.query(
    'SELECT evaluator_id FROM po_assignments WHERE po_id = ? AND category = ? AND period = ?',
    [po_id, category, period]
  );
  if (!assignment) return false;
  if (assignment.evaluator_id == null) return true; // whole-team evaluator
  return assignment.evaluator_id === user.id;
}

// Same for approving. NULL approver_id = any approver on that team can decide
// (and therefore the block appears in every matching approver's queue).
async function canApprove(pool, user, po_id, category, period) {
  if (user.role === 'admin') return true;
  if (user.role !== 'approver' || user.team !== category) return false;

  const [[assignment]] = await pool.query(
    'SELECT approver_id FROM po_assignments WHERE po_id = ? AND category = ? AND period = ?',
    [po_id, category, period]
  );
  if (!assignment) return false;
  if (assignment.approver_id == null) return true; // whole-team approver
  return assignment.approver_id === user.id;
}

// This po/category/period block's current decision, if any ('approved' or
// 'rejected' — null if it's still awaiting a decision, or marked 'na', which
// isn't a lock either way). Shared by canEditRatingValue below: 'rejected' is
// what hands editing over to the approver, and 'approved' is what finalizes
// the block and takes editing away from everyone but an admin.
async function ratingDecisionStatus(pool, po_id, category, period) {
  const [[row]] = await pool.query(
    `SELECT approval_status FROM ratings WHERE po_id = ? AND category = ? AND period = ?
     AND approval_status IN ('approved', 'rejected') LIMIT 1`,
    [po_id, category, period]
  );
  return row ? row.approval_status : null;
}

// Whether `user` may write a rating *value* (a star score) for this block.
// - Admin: always.
// - The assigned evaluator: always. Their edit reopens the whole block for a
//   fresh approver decision, so an earlier approval is never silently kept.
// - The assigned approver: ONLY once they have rejected this block ("Not
//   Approved and Changed"). Approving is a decision, not an edit — an
//   approver who has set (or left) "Approved" has no business overwriting
//   the evaluator's numbers. Reject it first, then the corrected scores get
//   entered, then a fresh decision (approve or reject again) publishes them.
async function canEditRatingValue(pool, user, po_id, category, period) {
  if (user.role === 'admin') return true;
  const status = await ratingDecisionStatus(pool, po_id, category, period);
  if (user.role === 'evaluator') {
    if (!(await canEvaluate(pool, user, po_id, category, period))) return false;
    return true;
  }
  if (user.role === 'approver') {
    if (!(await canApprove(pool, user, po_id, category, period))) return false;
    return status === 'rejected';
  }
  return false;
}

// Whether `user` may mark this block "NA — Not Applicable". This is a status
// decision, not a score edit, so it's independent of canEditRatingValue's
// approved/rejected lock above: either the assigned evaluator (the normal
// "this doesn't apply, nothing to rate" call) or the assigned approver/admin.
async function canSetNA(pool, user, po_id, category, period) {
  if (user.role === 'admin') return true;
  if (user.role === 'evaluator') return canEvaluate(pool, user, po_id, category, period);
  if (user.role === 'approver') return canApprove(pool, user, po_id, category, period);
  return false;
}

// Only the assigned evaluator (or an admin) may turn their own NA decision
// back into a pending/reviewable block.
async function canResetToPending(pool, user, po_id, category, period) {
  if (user.role === 'admin') return true;
  return user.role === 'evaluator' && canEvaluate(pool, user, po_id, category, period);
}

module.exports = { authenticate, requireAdmin, canEvaluate, canApprove, canEditRatingValue, canSetNA, canResetToPending };
