/* ============================================================
 * 96-api-approval-widget.js
 * The single shared entry point for status decisions:
 * window.decideCategoryApproval(category, decision) where decision is
 * 'approved' | 'rejected' ("Not Approved and Changed") | 'na' | 'pending'. Used by
 * the Approval Status dropdown on the category detail page
 * (85-view-completeness.js) and by the "My Approvals" queue page
 * (98-view-my-queue.js) — there is exactly one place that talks to
 * POST /api/ratings/approve, so there's exactly one place that can
 * get the "which PO/period is this for" logic wrong.
 * Must load AFTER 05-login-gate.js and 25-api-loader.js.
 * ============================================================ */
(function () {
  function currentPoNumber() {
    // Bare identifier, NOT window.activeRatingKey — activeRatingKey is a `let`
    // global lexical binding (declared in 10-state-and-helpers.js). Classic
    // scripts share that binding directly, but it never becomes a window
    // property, so `window.activeRatingKey` is always undefined and this
    // used to report "no PO open" even when one clearly was — the exact bug
    // behind "I open a PO and try to approve, and it just breaks."
    if (!activeRatingKey) return null;
    const m = activeRatingKey.match(/^po:([^|]*)\|ven:([^|]*)\|item:(.*)$/);
    return (m && m[1]) ? m[1] : null;
  }

  const DECISION_LABEL = { approved: 'Approved', rejected: 'Marked "Not Approved and Changed"', na: 'Marked Not Applicable', pending: 'Returned to Pending Review' };
  const DECISION_VERB = { approved: 'approve', rejected: 'reject ("Not Approved and Changed")', na: 'mark as Not Applicable', pending: 'return to Pending Review' };

  // Shared by the Approval Status dropdown on the category page
  // (85-view-completeness.js) and the My Approvals queue
  // (98-view-my-queue.js). decision: 'approved' | 'rejected' | 'na' | 'pending'
  window.decideCategoryApproval = async function (category, decision) {
    const poNumber = currentPoNumber();
    if (!poNumber) {
      alert('Open a specific PO in the Scorecard first.');
      return;
    }

    const poRow = DB['api::pos']?.rows.find(r => r.poNum === poNumber);
    const poId = poRow?._poId;
    if (!poId) { alert(`Could not find PO "${poNumber}" in the database.`); return; }

    // 'na' has its own, broader authorization rule (the evaluator may set it
    // too, not just the approver) — see canSetNAForPO in 05-login-gate.js.
    const authorized = decision === 'na'
      ? (window.canSetNAForPO ? window.canSetNAForPO(category, poId, activeQuarter) : true)
      : decision === 'pending'
        ? (window.canResetToPendingForPO ? window.canResetToPendingForPO(category, poId, activeQuarter) : true)
        : (window.canApproveCategoryForPO ? window.canApproveCategoryForPO(category, poId, activeQuarter) : true);
    if (!authorized) {
      alert(`You're not authorized to ${DECISION_VERB[decision] || decision} ${category.toUpperCase()} ratings for this PO — it isn't assigned to you.`);
      return;
    }

    let changeReason = window.VPR_APPROVER_CHANGE_REASON || null;
    if (decision === 'rejected' && window.AUTH && ['approver', 'admin'].includes(window.AUTH.user.role)) {
      changeReason = window.prompt('Why do you disagree with the evaluator\'s rating? This reason is required and will be visible in the internal history.', changeReason || '');
      if (changeReason == null || !changeReason.trim()) {
        alert('A reason is required for Not Approved and Changed.');
        return;
      }
      window.VPR_APPROVER_CHANGE_REASON = changeReason.trim();
    } else if (decision !== 'rejected') {
      window.VPR_APPROVER_CHANGE_REASON = null;
      changeReason = null;
    }

    const res = await window.apiFetch('/api/ratings/approve', {
      method: 'POST',
      body: JSON.stringify({ po_id: poId, category, period: activeQuarter, decision, change_reason: changeReason }),
    });
    const data = await res.json();

    if (!res.ok) {
      alert('Could not save decision: ' + (data.error || res.status));
      return;
    }

    const msg = `${DECISION_LABEL[decision] || decision}: ${data.ratings_updated} rating(s) for PO ${poNumber}`;
    if (typeof toast === 'function') toast(msg, 'ok'); else alert(msg);
    console.info('[approval-widget]', msg);

    // Re-pull ratings/assignments so PO_REJECTED/PO_APPROVED and
    // categoryMeta.status reflect the decision immediately, then re-render
    // whatever's on screen — a status change needs to instantly re-lock or
    // unlock the stars, not wait for a manual refresh.
    if (typeof window.hydrateRatingsFromAPI === 'function' && DB['api::pos']) {
      await window.hydrateRatingsFromAPI(DB['api::pos'].rows);
    }
    document.dispatchEvent(new CustomEvent('vpr-data-refreshed'));
    if (typeof window.rCategoryDetail === 'function' && activeRatingKey) {
      window.rCategoryDetail(category);
    }
  };
})();
