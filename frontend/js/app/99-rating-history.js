/* 99-rating-history.js
 * Internal-only audit and comparison UI. Vendor-facing screens do not load this.
 */
(function () {
  function esc(value) {
    return typeof hesc === 'function' ? hesc(value == null ? '' : String(value)) : String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function currentBlock() {
    const match = activeRatingKey && activeRatingKey.match(/^po:([^|]*)\|/);
    const poNumber = match ? match[1] : null;
    const po = poNumber && DB['api::pos'] ? DB['api::pos'].rows.find(r => r.poNum === poNumber) : null;
    return po ? { poId: po._poId, poNumber, category: activeHistoryCategory, period: activeQuarter } : null;
  }
  let activeHistoryCategory = null;
  window.openHistoryModal = async function (category) {
    activeHistoryCategory = category;
    const block = currentBlock();
    if (!block) return alert('Open a specific PO before viewing history.');
    let rows = [];
    try {
      const res = await window.apiFetch(`/api/ratings/history?po_id=${encodeURIComponent(block.poId)}&category=${encodeURIComponent(block.category)}&period=${encodeURIComponent(block.period)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      rows = Array.isArray(data) ? data : [];
    } catch (err) {
      return alert('Could not load rating history: ' + err.message);
    }
    let modal = document.getElementById('vpr-history-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'vpr-history-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(10,18,28,.55);';
      document.body.appendChild(modal);
    }
    const body = rows.length ? rows.map(r => `
      <div style="padding:12px 0;border-bottom:1px solid var(--brd,#d8dee6);">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <strong>${esc(r.event_type === 'APPROVER_CHANGED_RATING' ? 'Approver changed rating' : r.event_type === 'APPROVER_MARKED_NOT_APPROVED_AND_CHANGED' ? 'Not Approved and Changed' : r.event_type === 'BASELINE_IMPORTED' ? 'Baseline imported' : 'Evaluator changed rating')}</strong>
          <span class="pill pill-b">V${esc(r.version_no)}</span>
          <span style="color:var(--t3,#687482);font-size:11px;">${esc(r.created_at || '')}</span>
        </div>
        <div style="margin-top:6px;font-size:12px;">Parameter: <strong>${esc(r.parameter_code)}</strong> · ${esc(r.actor_display_name || r.actor_name || 'Unknown')} (${esc(r.actor_role || '')})</div>
        <div style="margin-top:4px;font-size:12px;color:var(--t2,#475569);">${r.old_score == null ? '—' : esc(r.old_score)} → <strong>${r.new_score == null ? '—' : esc(r.new_score)}</strong></div>
        ${r.reason ? `<div style="margin-top:5px;font-size:12px;background:var(--s3,#f5f7fa);padding:7px;border-radius:4px;"><strong>Reason:</strong> ${esc(r.reason)}</div>` : ''}
      </div>`).join('') : '<div style="padding:22px 0;color:var(--t3,#687482);">No history is recorded for this block yet. Run the rating-history migration to capture existing ratings as a baseline.</div>';
    modal.innerHTML = `<div style="width:min(760px,96vw);max-height:86vh;overflow:auto;background:var(--s1,#fff);border:1px solid var(--brd2,#cbd5e1);border-radius:8px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.25);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;"><div><h2 style="margin:0;font-size:18px;">Internal Rating History</h2><div style="font-size:12px;color:var(--t3,#687482);margin-top:4px;">PO ${esc(block.poNumber)} · ${esc(block.category.toUpperCase())} · ${esc(block.period)}</div></div><button class="pgb" onclick="document.getElementById('vpr-history-modal').remove()">Close</button></div>
      <div style="margin-top:14px;">${body}</div>
    </div>`;
  };
})();
