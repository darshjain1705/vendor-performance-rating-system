/* ============================================================
 * 98-view-my-queue.js
 * "My Ratings" (evaluator) / "My Approvals" (approver) / "Assignments
 * Overview" (admin) — a dedicated queue view so the two roles are no
 * longer stuck looking at the same generic Scorecard UI. This is the
 * one place that answers "what's actually mine to do right now":
 *   - an evaluator sees exactly which assigned PO/category blocks
 *     still need scoring, and which ones an approver rejected
 *   - an approver sees exactly which assigned blocks have been fully
 *     rated by the evaluator and are sitting in their queue, so they
 *     don't have to go hunting through every PO to notice one
 *   - an admin gets a read-only roll-up of every assignment
 * Reuses the exact same permission data (window.PO_ASSIGNMENTS,
 * getAssignmentFor) that gates the star clicks and Approve/Reject
 * buttons, so this list can never promise access the real checks
 * would then refuse.
 * Must load AFTER 05-login-gate.js, 25-api-loader.js, 70-rating-
 * matrix-and-scope.js, 85-view-completeness.js and 90-reports-and-
 * modals.js (uses LNT_MATRIX, stableKey, getQuarterRatingsForItem,
 * getQuarterMetaForItem, isNAStatus).
 * ============================================================ */

// Jump straight into a specific PO's category detail from the queue —
// unlike gotoRatingItem() this does NOT auto-hop to whichever half
// happens to have data, since the queue row already tells us the exact
// period this assignment belongs to.
window.openMyQueueRow = function (key, catId, period) {
  activeRatingKey = key;
  try { appStorage.setItem('lnt_activeRatingKey', key); } catch (e) {}
  if (period && period !== activeQuarter) setActiveQuarter(period, null, true);
  go('scorecard', true);
  if (typeof rCategoryDetail === 'function') rCategoryDetail(catId);
};

function computeMyQueue() {
  const user = window.AUTH && window.AUTH.user;
  // Bare `DB`, not window.DB — DB is a `let` global (10-state-and-helpers.js),
  // never a window property (see the same note in 85-view-completeness.js /
  // 95-api-ratings-sync.js — this bug class is exactly why the queue below
  // was showing "nothing assigned to you" even with real assignments).
  const posRows = DB['api::pos'] ? DB['api::pos'].rows : [];
  const period = activeQuarter;
  const rows = [];
  if (!user || !posRows.length) return { user, period, rows };

  posRows.forEach(poRow => {
    if (!poRow._poId) return;
    LNT_MATRIX.forEach(cat => {
      if (user.role !== 'admin' && user.team !== cat.id) return;
      const a = window.getAssignmentFor ? window.getAssignmentFor(poRow._poId, cat.id, period) : null;
      if (!a) return;

      // NULL evaluator_id / approver_id means "whole team" — every matching
      // role on that team should see the block in their queue.
      let mine = false, viewerRole = user.role;
      if (user.role === 'admin') mine = true;
      else if (user.role === 'evaluator') mine = a.evaluator_id == null || a.evaluator_id === user.id;
      else if (user.role === 'approver') mine = a.approver_id == null || a.approver_id === user.id;
      if (!mine) return;

      const key = stableKey(poRow);
      const ratings = (typeof getQuarterRatingsForItem === 'function') ? getQuarterRatingsForItem(key, period) : {};
      const metaAll = (typeof getQuarterMetaForItem === 'function') ? getQuarterMetaForItem(key, period) : {};
      const meta = (metaAll && metaAll[cat.id]) || {};

      let ratedCount = 0;
      cat.params.forEach((_, i) => { const v = ratings[`${cat.id}_${i}`]; if (v != null && v !== '') ratedCount++; });
      const total = cat.params.length;
      const statusRaw = (meta.status || '').trim();
      const statusLower = statusRaw.toLowerCase();

      // state: 'not_started' | 'in_progress' | 'awaiting_approval' | 'rejected' | 'approved' | 'na'
      let state;
      if (isNAStatus(statusRaw)) state = 'na';
      else if (statusLower === 'rejected') state = 'rejected';
      else if (/^approved$/i.test(statusRaw) || /^changed and approved$/i.test(statusRaw)) state = 'approved';
      else if (ratedCount === 0) state = 'not_started';
      else if (ratedCount < total) state = 'in_progress';
      else state = 'awaiting_approval';

      rows.push({
        key, poNum: poRow.poNum || '—', vendorName: poRow.vendorName || poRow.vendor || '—',
        vendorCode: poRow.vendor || '', item: poRow.jobDesc || poRow.item || '—',
        category: cat.id, categoryName: cat.name, ratedCount, total, state,
        evaluatorName: meta.buyer || '', approverName: meta.approver || '',
        viewerRole,
      });
    });
  });

  return { user, period, rows };
}

const QUEUE_STATE_META = {
  not_started:       { label: 'Not started',                      color: 'var(--t3)',   pill: 'pill-m' },
  in_progress:        { label: 'In progress',                      color: 'var(--amb)', pill: 'pill-a' },
  awaiting_approval:  { label: 'Awaiting your decision',          color: 'var(--amb)', pill: 'pill-a' },
  rejected:           { label: 'Rejected & Changed by Approver',  color: 'var(--red)', pill: 'pill-r' },
  approved:           { label: 'Approved',                         color: 'var(--grn)', pill: 'pill-g' },
  na:                 { label: 'N/A',                              color: 'var(--t3)',  pill: 'pill-m' },
};

function _myQueueRowHTML(r, primaryAction, showCategory = true) {
  const sm = QUEUE_STATE_META[r.state] || QUEUE_STATE_META.not_started;
  let statusLabel = sm.label;
  if (r.viewerRole === 'evaluator') {
    if (r.state === 'awaiting_approval') statusLabel = 'Awaiting approver’s decision';
    else if (r.state === 'rejected') statusLabel = 'Rejected & Changed by Approver';
  } else if (r.viewerRole === 'approver') {
    if (r.state === 'awaiting_approval') statusLabel = 'Ready for your decision';
    else if (r.state === 'rejected') statusLabel = 'You rejected — correcting';
  }
  const fillPct = r.total ? Math.round(r.ratedCount / r.total * 100) : 0;
  const assignedLine = r.viewerRole === 'admin'
    ? `<div class="rp" style="margin-top:2px;">Evaluator: ${hesc(r.evaluatorName || '—')} · Approver: ${hesc(r.approverName || '—')}</div>`
    : '';
  return `
    <tr data-queue-state="${hesc(r.state)}" data-evaluator="${hesc((r.evaluatorName || '').toLowerCase())}">
      <td><strong>${hesc(r.vendorName)}</strong>${r.vendorCode ? `<div class="rp">${vendorCodeDisplay ? vendorCodeDisplay(r.vendorCode) : hesc(r.vendorCode)}</div>` : ''}</td>
      <td style="font-family:var(--mono);">${hesc(r.poNum)}</td>
      <td>${hesc(r.item)}${assignedLine}</td>
      ${showCategory ? `<td><span class="pill" style="background:var(--s3);color:var(--t2);">${hesc(r.categoryName)}</span></td>` : ''}
      <td style="min-width:120px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;height:6px;background:var(--s4);border:1px solid var(--brd);overflow:hidden;"><div style="height:100%;width:${fillPct}%;background:${sm.color};"></div></div>
          <span style="font-family:var(--mono);font-size:11px;color:var(--t3);white-space:nowrap;">${r.ratedCount}/${r.total}</span>
        </div>
      </td>
      <td><span class="pill ${sm.pill}">${statusLabel}</span></td>
      <td style="text-align:right;">
        <button class="pgb" onclick="openMyQueueRow('${esc(r.key)}','${r.category}','${r.viewerRole === 'admin' ? activeQuarter : activeQuarter}')">${primaryAction} &rarr;</button>
      </td>
    </tr>`;
}

function _myQueueSection(title, icon, rows, primaryAction, emptyMsg, accentColor, showCategory = true) {
  if (!rows.length) return '';
  return `
    <div class="pn" style="margin-bottom:16px;">
      <div class="phd">
        <h3 class="pt">${icon} ${hesc(title)}</h3>
        <span class="ch" style="background:${accentColor};color:#fff;border-color:${accentColor};">${rows.length}</span>
      </div>
      <div class="tw">
        <table class="dt">
          <thead><tr>
            <th>Vendor</th><th>PO Number</th><th>Project</th>${showCategory ? '<th>Category</th>' : ''}<th>Fill</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${rows.map(r => _myQueueRowHTML(r, primaryAction, showCategory)).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

window.rMyQueue = function () {
  const { user, period, rows } = computeMyQueue();

  if (!user) {
    setM(`<div class="shd"><h2 class="stitle">My Queue</h2></div><div class="pn"><div class="pb"><div class="empty">Sign in to see your assignments.</div></div></div>`);
    return;
  }

  const isEvaluator = user.role === 'evaluator';
  const isApprover = user.role === 'approver';
  const isAdmin = user.role === 'admin';
  const evaluatorOptions = [...new Set(rows.map(r => r.evaluatorName).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map(name => `<option value="${hesc(name.toLowerCase())}">${hesc(name)}</option>`).join('');

  const pageTitle = isEvaluator ? 'My Ratings' : isApprover ? 'My Approvals' : 'Assignments Overview';
  const pageSub = isEvaluator
    ? `Every PO/period block an admin has assigned to you as the ${hesc((user.team || '').toUpperCase())} evaluator.`
    : isApprover
      ? `Every PO/period block an admin has assigned to you as the ${hesc((user.team || '').toUpperCase())} approver.`
      : `Every PO/period assignment across all teams, for ${hesc(period)}.`;

  if (!rows.length) {
    setM(`
      <div class="shd">
        <div><h2 class="stitle">${hesc(pageTitle)}</h2><span class="ch ch-p">${hesc(period)}</span></div>
      </div>
      <div class="pn"><div class="pb"><div class="empty">
        ${isAdmin
          ? 'No PO assignments exist for this period yet. Use the <strong>Assign PO</strong> button to assign evaluators/approvers.'
          : `Nothing assigned to you for <strong>${hesc(period)}</strong> yet. Ask an admin to assign you to a PO's ${hesc((user.team||'').toUpperCase())} block using the <strong>Assign PO</strong> tool.`}
      </div></div></div>
    `);
    return;
  }

  let body;
  if (isEvaluator) {
    const todo = rows.filter(r => r.state === 'not_started' || r.state === 'in_progress');
    const pending = rows.filter(r => r.state === 'awaiting_approval');
    const rejected = rows.filter(r => r.state === 'rejected');
    const approved = rows.filter(r => r.state === 'approved');
    const na = rows.filter(r => r.state === 'na');
    body = [
      _myQueueSection('To Rate', '📝', todo, 'Rate', '', '#a82f1c', false),
      _myQueueSection('Submitted — Awaiting Approver Decision', '⏳', pending, 'View', '', '#9a6a07', false),
      rejected.length ? `
        <div class="pn" style="margin-bottom:16px;">
          <div class="phd"><h3 class="pt">✕ Rejected by Approver</h3><span class="ch" style="background:#a82f1c;color:#fff;border-color:#a82f1c;">${rejected.length}</span></div>
          <div class="pb" style="font-size:12px;color:var(--t3);padding-bottom:0;">The approver is correcting these directly — no action needed from you.</div>
          <div class="tw"><table class="dt"><thead><tr><th>Vendor</th><th>PO Number</th><th>Project</th><th>Fill</th><th>Status</th><th></th></tr></thead>
          <tbody>${rejected.map(r => _myQueueRowHTML(r, 'View', false)).join('')}</tbody></table></div>
        </div>` : '',
      _myQueueSection('Approved', '✓', approved, 'View', '', '#1e7d34', false),
      _myQueueSection('Not Applicable', '—', na, 'View', '', '#6b7885', false),
    ].join('');
  } else if (isApprover) {
    const decide = rows.filter(r => r.state === 'awaiting_approval');
    const correcting = rows.filter(r => r.state === 'rejected');
    const waiting = rows.filter(r => r.state === 'not_started' || r.state === 'in_progress');
    const approved = rows.filter(r => r.state === 'approved');
    const na = rows.filter(r => r.state === 'na');
    body = [
      _myQueueSection('Ready For Your Decision', '🔔', decide, 'Review', '', '#9a6a07'),
      _myQueueSection('You Rejected — Correcting', '✏️', correcting, 'Continue', '', '#a82f1c'),
      _myQueueSection('Waiting On Evaluator', '⏱', waiting, 'View', '', '#6b7885'),
      _myQueueSection('Approved', '✓', approved, 'View', '', '#1e7d34'),
      _myQueueSection('Not Applicable', '—', na, 'View', '', '#6b7885'),
    ].join('');
  } else {
    // Admin: one flat table, grouped loosely by state via the same sections
    // but every row shows who it's actually assigned to.
    const decide = rows.filter(r => r.state === 'awaiting_approval');
    const rejected = rows.filter(r => r.state === 'rejected');
    const inFlight = rows.filter(r => r.state === 'not_started' || r.state === 'in_progress');
    const approved = rows.filter(r => r.state === 'approved');
    const na = rows.filter(r => r.state === 'na');
    body = [
      _myQueueSection('Awaiting Approval', '⏳', decide, 'Open', '', '#9a6a07'),
      _myQueueSection('Rejected', '✕', rejected, 'Open', '', '#a82f1c'),
      _myQueueSection('In Progress', '📝', inFlight, 'Open', '', '#6b7885'),
      _myQueueSection('Approved', '✓', approved, 'Open', '', '#1e7d34'),
      _myQueueSection('Not Applicable', '—', na, 'Open', '', '#6b7885'),
    ].join('');
  }

  const filterBar = `
    <div class="pn" style="margin-bottom:16px;">
      <div class="pb" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <input id="my-queue-filter" class="sinp" placeholder="Filter by vendor, PO number or project..." oninput="filterMyQueue()" style="min-width:280px;flex:1;"/>
        ${isAdmin || isApprover ? `<select id="my-queue-evaluator" class="sinp" onchange="filterMyQueue()">
          <option value="">All evaluators</option>
          ${evaluatorOptions}
        </select>` : ''}
        <select id="my-queue-status" class="sinp" onchange="filterMyQueue()">
          <option value="">All statuses</option>
          <option value="not_started">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="awaiting_approval">Awaiting decision</option>
          <option value="rejected">Correcting</option>
          <option value="approved">Approved</option>
          <option value="na">Not applicable</option>
        </select>
      </div>
    </div>
  `;

  setM(`
    <div class="shd">
      <div>
        <h2 class="stitle">${hesc(pageTitle)}</h2>
        <div style="font-size:12px;color:var(--t3);margin-top:4px;">${pageSub}</div>
      </div>
      <span class="ch ch-p">${hesc(period)}</span>
    </div>
    ${filterBar}
    ${body}
  `);
};

window.filterMyQueue = function () {
  const query = (document.getElementById('my-queue-filter')?.value || '').trim().toLowerCase();
  const status = document.getElementById('my-queue-status')?.value || '';
  const evaluator = document.getElementById('my-queue-evaluator')?.value || '';
  
  document.querySelectorAll('tr[data-queue-state]').forEach(row => {
    const matches = (!query || row.textContent.toLowerCase().includes(query)) 
                 && (!status || row.dataset.queueState === status) 
                 && (!evaluator || row.dataset.evaluator === evaluator);
    row.style.display = matches ? '' : 'none';
  });
  
  // Hide section headers if all their rows are filtered out
  document.querySelectorAll('.pn').forEach(section => {
    const tbody = section.querySelector('tbody');
    if (!tbody) return; // skip the filter bar itself
    
    const visibleRows = Array.from(tbody.querySelectorAll('tr')).some(r => r.style.display !== 'none');
    section.style.display = visibleRows ? '' : 'none';
  });
};

// ---- Nav tab injection ---------------------------------------------------
// Only meaningful once someone's logged in with a role that actually has a
// queue (evaluator/approver/admin) — the static nav in vendor_rating.html
// doesn't carry this tab because it depends on who's signed in.
(function () {
  function queueBadgeCount(rows, role) {
    if (role === 'evaluator') return rows.filter(r => r.state === 'not_started' || r.state === 'in_progress').length;
    if (role === 'approver') return rows.filter(r => r.state === 'awaiting_approval').length;
    return 0;
  }

  function injectNavTab() {
    if (!window.AUTH || document.getElementById('nav-myqueue')) return;
    const user = window.AUTH.user;
    const label = user.role === 'evaluator' ? 'My Ratings' : user.role === 'approver' ? 'My Approvals' : 'Assignments';

    const navArea = document.querySelector('.tnav-area');
    if (!navArea) return;

    const { rows } = computeMyQueue();
    const badgeCount = queueBadgeCount(rows, user.role);

    const el = document.createElement('div');
    el.className = 'nav nav-hl';
    el.id = 'nav-myqueue';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.onclick = () => go('myqueue');
    el.innerHTML = `
      <svg class="nav-ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      ${hesc(label)}${badgeCount ? `<span class="nbadge">${badgeCount}</span>` : ''}
    `;
    navArea.appendChild(el);
    // The role tab is appended last; keep it visible rather than clipping its
    // label behind the fixed right-side header controls.
    requestAnimationFrame(() => { navArea.scrollLeft = navArea.scrollWidth; });
    if (!document.getElementById('topbar-user')) {
      const identity = document.createElement('div');
      identity.id = 'topbar-user'; identity.className = 'topbar-user';
      identity.innerHTML = `<strong>${hesc(user.name || user.username)}</strong><span>${hesc(user.role)}${user.team ? ` · ${hesc(user.team.toUpperCase())}` : ''}</span>`;
      document.querySelector('.tright')?.prepend(identity);
    }
  }

  document.addEventListener('vpr-auth-ready', injectNavTab);

  // Assignments/ratings can change after an Approve/Reject decision or a
  // fresh data load — keep the badge count honest without a page reload.
  // Also doubles as a fallback: if vpr-data-refreshed (fired at the end of
  // loadDataFromAPI) lands before the tab exists yet, this creates it too.
  document.addEventListener('vpr-data-refreshed', () => {
    if (!window.AUTH) return;
    if (!document.getElementById('nav-myqueue')) { injectNavTab(); return; }
    const el = document.getElementById('nav-myqueue');
    const { rows } = computeMyQueue();
    const badgeCount = queueBadgeCount(rows, window.AUTH.user.role);
    const existingBadge = el.querySelector('.nbadge');
    if (existingBadge) existingBadge.remove();
    if (badgeCount) el.insertAdjacentHTML('beforeend', `<span class="nbadge">${badgeCount}</span>`);
    // If the My Queue page is the one currently on screen, keep it live too.
    if (document.getElementById('nav-myqueue').classList.contains('on') && typeof window.rMyQueue === 'function') {
      window.rMyQueue();
    }
  });
})();
