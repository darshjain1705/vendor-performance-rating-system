/* ============================================================
 * 25-api-loader.js
 * Loads Vendor + PO + rating data from the backend. No longer runs on its
 * own — 05-login-gate.js calls window.loadDataFromAPI() once the user is
 * authenticated, and every request goes through window.apiFetch() so it
 * carries the Authorization header.
 * ============================================================ */

function serverText(value) {
  return value == null ? '' : String(value).trim();
}

function dashboardVendorCode(value) {
  return serverText(value).replace(/\s+/g, ' ').toUpperCase();
}

function serverNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dashboardScoreOutOfFive(value) {
  const n = serverNumber(value);
  if (n == null) return null;
  return n > 0 && n <= 1 ? Number((n * 5).toFixed(2)) : n;
}

function serverRatingKey(poRow) {
  return stableKey(poRow);
}

// The migration stores workbook codes such as A1/B3/C11/D10, while dashboard
// edits use internal keys such as scm_0/edrc_2/quality_10/operation_9.
function serverParameterKey(category, code) {
  const cat = serverText(category).toLowerCase();
  const raw = serverText(code).toLowerCase();
  const internal = raw.match(/^(scm|edrc|quality|operation)_(\d+)$/);
  if (internal) return `${internal[1]}_${Number(internal[2])}`;
  const workbook = raw.match(/^[a-d](\d+)$/);
  if (!workbook) return null;
  const index = Number(workbook[1]) - 1;
  return `${cat}_${index}`;
}

function serverRatingVariants(poRow) {
  const po = serverText(poRow.poNum);
  const vendor = dashboardVendorCode(poRow.vendor);
  const item = serverText(poRow.item);
  return [
    `po:${po}|ven:${vendor}|item:${item}`,
    `po:${po}|ven:|item:`,
  ];
}

function serverPutItemValue(map, variants, parameterKey, value) {
  // Ratings API returns ORDER BY updated_at DESC. First write wins so a newer
  // scm_0 save is not overwritten by an older imported A1 row that maps to
  // the same parameterKey.
  variants.forEach(sk => {
    if (!map[sk]) map[sk] = {};
    if (map[sk][parameterKey] == null) map[sk][parameterKey] = value;
  });
}

function serverPutCategoryMeta(map, variants, category, value) {
  variants.forEach(sk => {
    if (!map[sk]) map[sk] = {};
    const prev = map[sk][category] || {};
    // Prefer non-empty remarks/status already captured from a newer row.
    const merged = Object.assign({}, value, prev);
    if (prev.remarks) merged.remarks = prev.remarks;
    else if (value.remarks) merged.remarks = value.remarks;
    if (prev.status) merged.status = prev.status;
    else if (value.status) merged.status = value.status;
    if (prev.buyer) merged.buyer = prev.buyer;
    else if (value.buyer) merged.buyer = value.buyer;
    if (prev.approver) merged.approver = prev.approver;
    else if (value.approver) merged.approver = value.approver;
    map[sk][category] = merged;
  });
}

async function hydrateRatingsFromAPI(posRows) {
  const [ratingsRes, assignmentsRes] = await Promise.all([
    window.apiFetch('/api/ratings'),
    window.apiFetch('/api/assignments'),
  ]);
  if (!ratingsRes.ok) throw new Error('Ratings API returned ' + ratingsRes.status);
  if (!assignmentsRes.ok) throw new Error('Assignments API returned ' + assignmentsRes.status);

  const ratings = await ratingsRes.json();
  const assignments = await assignmentsRes.json();
  const poById = new Map(posRows.map(p => [String(p._poId), p]));
  const itemMaps = { H1: {}, H2: {} };
  const metaMaps = { H1: {}, H2: {} };
  const progressMaps = { H1: {}, H2: {} };
  const itemByQuarterPO = {};

  // The category sheets’ ITEM value is different from the PO Master project
  // description used by stableKey(). Keep it in PO_ITEM_MAP for item views,
  // while the rating bag itself is keyed by the PO row’s stable key.
  PO_ITEM_MAP = {};

  const getPO = id => poById.get(String(id));
  const ensureQuarter = period => ['H1', 'H2'].includes(period) ? period : null;
  const addMeta = (poRow, period, category, value) => {
    const q = ensureQuarter(period);
    if (!q || !poRow || !category) return;
    serverPutCategoryMeta(metaMaps[q], serverRatingVariants(poRow), category, value);
  };

  // Who's actually allowed to touch which PO's block — mirrors the server's
  // po_assignments-only rule (no team-wide fallback). Keyed by
  // "<po_id>|<category>|<period>" -> { evaluator_id, approver_id }.
  // Consulted by canEditCategoryForPO/canApproveCategoryForPO in
  // 05-login-gate.js so the UI reflects the same rule the backend enforces.
  window.PO_ASSIGNMENTS = {};
  assignments.forEach(a => {
    const period = serverText(a.period).toUpperCase();
    const category = serverText(a.category).toLowerCase();
    if (!ensureQuarter(period) || !category) return;
    // Keep names here too — the detail screen reads them when categoryMeta
    // is empty (key mismatch or no rating rows yet).
    window.PO_ASSIGNMENTS[`${a.po_id}|${category}|${period}`] = {
      evaluator_id: a.evaluator_id ?? null,
      approver_id: a.approver_id ?? null,
      evaluator_name: serverText(a.evaluator_name),
      approver_name: serverText(a.approver_name),
    };
  });

  // Blocks an approver has rejected — that's what unlocks their own edit
  // rights on the stars (see canEditRatingValue on the server, and
  // canEditCategoryForPO on the client). Keyed the same way as above.
  window.PO_REJECTED = new Set();
  // Blocks that have been Approved — the mirror-image lock: once set, NOBODY
  // (evaluator or approver) can edit the stars until a fresh decision moves
  // it off 'approved'. Also server-side in canEditRatingValue.
  window.PO_APPROVED = new Set();

  // Assignments are the source of truth for work ownership and must be loaded
  // even when a category has no score rows yet.
  const buyerTeamTally = {};
  assignments.forEach(a => {
    const poRow = getPO(a.po_id);
    const period = serverText(a.period).toUpperCase();
    const category = serverText(a.category).toLowerCase();
    
    // Auto-tag tally building
    const evName = serverText(a.evaluator_name);
    if (evName && category) {
      const bk = normBuyerKey(evName);
      if (!buyerTeamTally[bk]) buyerTeamTally[bk] = { display: evName, teams: {} };
      buyerTeamTally[bk].teams[category] = (buyerTeamTally[bk].teams[category] || 0) + 1;
    }

    if (!poRow || !ensureQuarter(period)) return;
    addMeta(poRow, period, category, {
      buyer: evName,
      approver: serverText(a.approver_name),
      status: '',
      remarks: '',
      apprFilled: false,
    });
  });

  // Apply the team auto-tags so evaluators correctly map to their primary department
  if (typeof applyBuyerTeamAutoTags === 'function') {
    applyBuyerTeamAutoTags(buyerTeamTally);
  }

  // ---- First pass: harvest item names from ALL rating rows into PO_ITEM_MAP -----
  // The POs endpoint is filtered to the active period so posRows may not contain
  // every PO that has ratings. If we only extract r.item inside the main loop
  // (where getPO may return null for those missing POs), many item names are lost.
  // Ratings rows carry the PO's po_number directly so we can build the map up-front
  // without needing the posRows lookup at all.
  ratings.forEach(r => {
    if (!r.item || !r.po_number) return;
    const period = serverText(r.period).toUpperCase();
    if (!ensureQuarter(period)) return;
    const mapKey = `${period}|${serverText(r.po_number)}`;
    if (!PO_ITEM_MAP[mapKey]) PO_ITEM_MAP[mapKey] = serverText(r.item);
  });

  ratings.forEach(r => {
    const poRow = getPO(r.po_id);
    const period = serverText(r.period).toUpperCase();
    const category = serverText(r.category).toLowerCase();
    if (!poRow || !ensureQuarter(period) || !category) return;

    // PO_ITEM_MAP already populated in the first pass above; skip duplicate logic here.

    const variants = serverRatingVariants(poRow);
    const parameterKey = serverParameterKey(category, r.parameter_code);

    // The old migration stored the workbook's normalized FINAL SCORE /5 value
    // (0..1, e.g. 0.8133) in `score`. The dashboard needs the parameter's
    // 1..5 value, so prefer the evaluator/approver parameter columns and only
    // fall back to score for API-created rows that have no separate columns.
    const sourceStatus = serverText(r.source_status);
    const approvalStatusEarly = serverText(r.approval_status).toLowerCase();
    // When the block was resubmitted by the evaluator, any leftover
    // approver_score is stale (the prior decision was voided). Prefer the
    // evaluator's new value so the approver sees the updated stars, not the
    // old correction. Otherwise: approver correction wins, then evaluator,
    // then the live score column. final_score is a category total, not a
    // parameter/star value — never use it here.
    const score = (approvalStatusEarly === 'resubmitted' || approvalStatusEarly === 'awaiting' || approvalStatusEarly === 'pending')
      ? (dashboardScoreOutOfFive(r.evaluator_score) ?? dashboardScoreOutOfFive(r.score) ?? dashboardScoreOutOfFive(r.approver_score))
      : (dashboardScoreOutOfFive(r.approver_score) ?? dashboardScoreOutOfFive(r.evaluator_score) ?? dashboardScoreOutOfFive(r.score));
    if (parameterKey && score != null) {
      serverPutItemValue(itemMaps[period], variants, parameterKey, score);
    }

    // The live approval_status column must win over the imported workbook
    // status: once someone in the app sets a decision (approved/rejected/na),
    // that's the current truth and source_status is just what the Excel row
    // said at migration time, frozen forever after. Checking source_status
    // first (the old order here) meant an approver's "Not Approved and
    // Changed" on a PO that was already "Approved" in the workbook could
    // never be seen — the dropdown kept showing "Approved" even though
    // approval_status had genuinely changed to 'rejected' in the database.
    // NOTE: this string is pattern-matched elsewhere (isRejectedByMe in
    // 85-view-completeness.js, the state machine in 98-view-my-queue.js) as
    // the literal word "rejected" — keep it as-is here. The dropdown/UI only
    // ever *displays* it as "Not Approved and Changed"; it doesn't change
    // what's stored or compared.
    const approvalStatus = approvalStatusEarly;
    const categoryStatus =
      approvalStatus === 'approved' ? 'Approved' :
      approvalStatus === 'rejected' ? 'Rejected' :
      approvalStatus === 'na' ? 'NA' :
      approvalStatus === 'resubmitted' ? 'Pending' :
      (sourceStatus || '');

    if (approvalStatus === 'rejected') {
      window.PO_REJECTED.add(`${r.po_id}|${category}|${period}`);
    } else if (approvalStatus === 'approved') {
      window.PO_APPROVED.add(`${r.po_id}|${category}|${period}`);
    }
    const remarks = serverText(r.remarks);
    const evaluatorName = serverText(r.evaluator_name);
    const approverName = serverText(r.approver_name);
    addMeta(poRow, period, category, {
      buyer: evaluatorName,
      approver: approverName,
      status: categoryStatus,
      remarks,
      apprFilled: serverNumber(r.approver_score) != null || ['approved', 'rejected'].includes(approvalStatus),
    });

    // Completeness and Team Workload need a separate evaluator-progress map.
    // Imported rows have evaluator_score; API-created rows use score.
    const evaluatorHasScore = serverNumber(r.evaluator_score) != null ||
      (serverNumber(r.evaluator_score) == null && serverNumber(r.score) != null && !sourceStatus);
    if (evaluatorHasScore) {
      if (!progressMaps[period]) progressMaps[period] = {};
      variants.forEach(sk => {
        if (!progressMaps[period][sk]) progressMaps[period][sk] = {};
        progressMaps[period][sk][category] = true;
      });
    }
  });

  // Build categoryRemarks from server meta so comments survive hydrate.
  // Previously this was always wiped to {}, so remarks only showed via the
  // meta fallback and local drafts disappeared after Save.
  const remarkMaps = { H1: {}, H2: {} };
  for (const q of ['H1', 'H2']) {
    const meta = metaMaps[q] || {};
    Object.keys(meta).forEach(sk => {
      Object.keys(meta[sk] || {}).forEach(catId => {
        const text = (meta[sk][catId] && meta[sk][catId].remarks) || '';
        if (!text) return;
        if (!remarkMaps[q][sk]) remarkMaps[q][sk] = {};
        if (!remarkMaps[q][sk][catId]) remarkMaps[q][sk][catId] = text;
      });
    });
  }

  // Replace browser-local rating snapshots with the server snapshot. This is
  // deliberate: MySQL is now the source of truth, and stale IndexedDB values
  // must not overwrite imported data after a refresh.
  const writes = [];
  for (const q of ['H1', 'H2']) {
    for (const base of ['lnt_itemRatings', 'lnt_categoryMeta', 'lnt_evalProgress', 'lnt_vendorRatings', 'lnt_paramRemarks', 'lnt_categoryRemarks']) {
      const key = `${base}_${q}`;
      if (typeof removeRatingRecord === 'function') writes.push(removeRatingRecord(key));
      else appStorage.removeItem(key);
    }
    appStorage.setItem(`lnt_itemRatings_${q}`, JSON.stringify(itemMaps[q]));
    appStorage.setItem(`lnt_categoryMeta_${q}`, JSON.stringify(metaMaps[q]));
    appStorage.setItem(`lnt_evalProgress_${q}`, JSON.stringify(progressMaps[q]));
    appStorage.setItem(`lnt_vendorRatings_${q}`, '{}');
    appStorage.setItem(`lnt_paramRemarks_${q}`, '{}');
    appStorage.setItem(`lnt_categoryRemarks_${q}`, JSON.stringify(remarkMaps[q]));
    if (typeof saveRatingRecord === 'function') {
      writes.push(saveRatingRecord(`lnt_itemRatings_${q}`, itemMaps[q]));
      writes.push(saveRatingRecord(`lnt_categoryMeta_${q}`, metaMaps[q]));
      writes.push(saveRatingRecord(`lnt_evalProgress_${q}`, progressMaps[q]));
      writes.push(saveRatingRecord(`lnt_vendorRatings_${q}`, {}));
      writes.push(saveRatingRecord(`lnt_paramRemarks_${q}`, {}));
      writes.push(saveRatingRecord(`lnt_categoryRemarks_${q}`, remarkMaps[q]));
    }
  }
  await Promise.all(writes);
  window._vprServerRatingsHydrated = true;
  if (typeof loadPersistedRatings === 'function') loadPersistedRatings();
  return { ratings: ratings.length, assignments: assignments.length };
}

async function loadDataFromAPI() {
  try {
    if (typeof toast === 'function') toast('Loading data from database…', 'ok');

    // ---- 1. Vendors ------------------------------------------------
    const vendorRes = await window.apiFetch('/api/vendors');
    if (!vendorRes.ok) throw new Error('Vendor API returned ' + vendorRes.status);
    const vendors = await vendorRes.json();

    VENDOR_DETAILS = {};
    VENDOR_MASTER_ROSTER = {};
    VENDOR_LOCATION = {};

    vendors.forEach(v => {
      const rec = {
        code: v.code, name: v.name,
        factory: v.factory_location || '', address: v.address || '', materialDesc: v.material_desc || v.category || '',
        c1Name: v.c1_name || '', c1Email: v.c1_email || '', c1Phone: v.c1_phone || '',
        c2Name: v.c2_name || '', c2Email: v.c2_email || '', c2Phone: v.c2_phone || '',
      };
      if (v.code) { VENDOR_DETAILS[normVenKey(v.code)] = rec; VENDOR_DETAILS[normCodeKey(v.code)] = rec; }
      if (v.name) { VENDOR_DETAILS[normVenKey(v.name)] = rec; }
      const rk = v.code ? normCodeKey(v.code) : normVenKey(v.name);
      VENDOR_MASTER_ROSTER[rk] = { code: v.code, name: v.name, location: v.factory_location || '' };

      // Populate VENDOR_LOCATION so vendorLocationFor() works for the region map and
      // the "Vendors by Region" Location column — mirrors what the Excel import path does.
      const loc = v.factory_location || '';
      if (loc) {
        if (v.code) {
          VENDOR_LOCATION[normVenKey(v.code)] = loc;
          VENDOR_LOCATION[normCodeKey(v.code)] = loc;
        }
        if (v.name) { VENDOR_LOCATION[normVenKey(v.name)] = loc; }
      }
    });

    // ---- 2. Purchase Orders (scoped to the active half-year) ---------------
    // Only fetch POs that have at least one assignment for the current period so
    // the vendor count on the dashboard reflects the active rating cycle rather
    // than the entire multi-year backlog. The backend filters by po_assignments.period.
    const activePeriod = (typeof activeQuarter === 'string' && activeQuarter) ? activeQuarter : '';
    const poUrl = activePeriod ? `/api/pos?period=${encodeURIComponent(activePeriod)}` : '/api/pos';
    const poRes = await window.apiFetch(poUrl);
    if (!poRes.ok) throw new Error('PO API returned ' + poRes.status);
    const pos = await poRes.json();

    const fmt = (d) => {
      if (!d) return '';
      const dt = new Date(d);
      return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    };

    const rows = pos.map((p, i) => {
      if (p.item_name) {
        const poKey = serverText(p.po_number);
        if (!PO_ITEM_MAP[`H1|${poKey}`]) PO_ITEM_MAP[`H1|${poKey}`] = p.item_name;
        if (!PO_ITEM_MAP[`H2|${poKey}`]) PO_ITEM_MAP[`H2|${poKey}`] = p.item_name;
      }
      return {
        item: p.item_name || '', ic: '', bu: p.bu || '',
        jobCode: p.job_code || '', jobDesc: p.job_desc || '',
        vendor: dashboardVendorCode(p.vendor_code), vendorName: p.vendor_name || '', vendorEmail: '',
      acc: p.buyer || '', poIssued: p.po_status || '', poNum: p.po_number || '',
      poVal: p.po_value || '', poDate: fmt(p.po_date), currency: p.currency || '',
      mfcStatus: '', mfcDate: '', leadTime: '', bgReq: '',
      payTerms: p.payment_terms || '', lc: '', qty: '',
      status: p.po_status || '', remarks: '', risk: '',
      cat: p.po_category || '', matRec: '', matPend: '', orderConf: false,
      expDel: fmt(p.delivery_end_date), delStart: fmt(p.delivery_start_date),
      sheet: 'PO Master (Database)', sheetId: 'api::pos', rowId: i + 1,
      // cache the numeric PO id right on the row so ratings, approvals, and
      // assignments can resolve the same server record without another lookup
      _poId: p.id,
    };
  });

    DB = {};
    DB['api::pos'] = {
      id: 'api::pos', name: 'PO Master (Database)', headers: [], fields: {},
      rows, source: 'MySQL API', sheetName: 'POs',
    };

    // ---- 3. Ratings + assignments ----------------------------------
    const ratingSummary = await hydrateRatingsFromAPI(rows);
    
    // Backfill the item name onto the PO rows. The item name often only exists in 
    // the ratings table (populated into PO_ITEM_MAP during hydration), so we must 
    // sync it back to the row object so `i.item` works globally across the UI.
    rows.forEach(r => {
      r.item = itemForScopePO(r.poNum) || r.item;
    });

    document.dispatchEvent(new CustomEvent('vpr-data-refreshed'));

    afterLoad();

    if (typeof toast === 'function') {
      toast(`Loaded from database: ${vendors.length} vendor(s), ${pos.length} PO(s), ${ratingSummary.ratings} rating row(s)`, 'ok');
    }
    console.info(`[api-loader] Loaded ${vendors.length} vendors, ${pos.length} POs, ${ratingSummary.ratings} ratings and ${ratingSummary.assignments} assignments`);
  } catch (err) {
    console.error('[api-loader] Failed to load from API:', err);
    if (typeof toast === 'function') {
      toast('Could not load data from backend — check the server and database', 'err');
    }
  }
}

window.loadDataFromAPI = loadDataFromAPI;

