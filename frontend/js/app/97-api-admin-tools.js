/* ============================================================
 * 97-api-admin-tools.js
 * Admin-only floating buttons: "+ Add PO" (POST /api/pos), "Assign
 * PO" (POST /api/assignments — pins a specific evaluator and/or
 * approver to one PO's category+period rating block), and "Bulk
 * Import" (POST /api/pos/bulk-import — the recurring "here's an
 * Excel of new POs plus who's rating each team's block" workflow).
 * An assignment is now required for anyone to touch a block at all:
 * there is no team-wide fallback, so leaving a role blank means
 * nobody (not even other people on that team) can rate/approve it
 * until you assign someone.
 * Must load AFTER 05-login-gate.js and 25-api-loader.js.
 * ============================================================ */
(function () {
  const CATEGORIES = ['scm', 'edrc', 'quality', 'operation'];

  // Not every non-2xx response is a JSON {error} body — a request that trips
  // Express's body-size limit (or a proxy/gateway error) comes back as an
  // HTML error page instead, and res.json() on that throws a confusing
  // "Unexpected token '<'" instead of surfacing what actually happened.
  async function safeJson(res) {
    try {
      return await res.json();
    } catch (e) {
      return { error: `Server returned ${res.status} ${res.statusText || ''} (not JSON) — the request may be too large or the server may be down.` };
    }
  }

  function overlay(title, bodyHTML, onSubmit) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:26px;width:380px;max-height:85vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.35);">
        <h3 style="margin:0 0 16px;font-size:16px;">${title}</h3>
        <form id="admin-tool-form">${bodyHTML}</form>
        <div id="admin-tool-error" style="margin-top:10px;color:#a11;font-size:12px;"></div>
        <div style="display:flex;gap:8px;margin-top:18px;">
          <button type="button" id="admin-tool-cancel" style="flex:1;padding:9px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer;">Cancel</button>
          <button type="button" id="admin-tool-submit" style="flex:1;padding:9px;border:none;background:#0072bc;color:#fff;border-radius:6px;font-weight:600;cursor:pointer;">Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#admin-tool-cancel').onclick = () => wrap.remove();
    wrap.querySelector('#admin-tool-submit').onclick = async () => {
      const errEl = wrap.querySelector('#admin-tool-error');
      errEl.textContent = '';
      try {
        await onSubmit(wrap);
        wrap.remove();
      } catch (err) {
        errEl.textContent = err.message || 'Something went wrong.';
      }
    };
    return wrap;
  }

  const field = (label, id, attrs = '') =>
    `<label style="display:block;font-size:12px;color:#555;margin-top:10px;">${label}</label>
     <input id="${id}" ${attrs} style="width:100%;padding:8px;margin-top:4px;box-sizing:border-box;border:1px solid #ccc;border-radius:5px;">`;

  function val(wrap, id) { return wrap.querySelector('#' + id).value.trim(); }

  // ---- Add PO ------------------------------------------------------
  function openAddPo() {
    const wrap = overlay('Add Purchase Order', `
      ${field('PO Number *', 'ap-num')}
      ${field('Vendor Code *', 'ap-vcode')}
      ${field('Vendor Name', 'ap-vname')}
      ${field('Job Code', 'ap-jobcode')}
      ${field('Job Description', 'ap-jobdesc')}
      ${field('Business Unit (BU)', 'ap-bu')}
      ${field('PO Value', 'ap-value', 'type="number" step="0.01"')}
      ${field('PO Date (YYYY-MM-DD)', 'ap-date', 'placeholder="2026-07-01"')}
      ${field('Currency', 'ap-currency')}
      ${field('Buyer', 'ap-buyer')}
    `, async (w) => {
      const po_number = val(w, 'ap-num');
      const vendor_code = val(w, 'ap-vcode');
      if (!po_number || !vendor_code) throw new Error('PO Number and Vendor Code are required.');

      const res = await window.apiFetch('/api/pos', {
        method: 'POST',
        body: JSON.stringify({
          po_number, vendor_code,
          vendor_name: val(w, 'ap-vname') || undefined,
          job_code: val(w, 'ap-jobcode') || undefined,
          job_desc: val(w, 'ap-jobdesc') || undefined,
          bu: val(w, 'ap-bu') || undefined,
          po_value: val(w, 'ap-value') ? Number(val(w, 'ap-value')) : undefined,
          po_date: val(w, 'ap-date') || undefined,
          currency: val(w, 'ap-currency') || undefined,
          buyer: val(w, 'ap-buyer') || undefined,
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

      toast(`PO ${po_number} created ✓`, 'ok');
      if (typeof window.loadDataFromAPI === 'function') window.loadDataFromAPI();
    });
  }

  // ---- Assign PO -----------------------------------------------------
  async function openAssignPo() {
    const [evalRes, apprRes] = await Promise.all([
      window.apiFetch('/api/evaluators?role=evaluator'),
      window.apiFetch('/api/evaluators?role=approver'),
    ]);
    const evaluators = evalRes.ok ? await evalRes.json() : [];
    const approvers = apprRes.ok ? await apprRes.json() : [];

    // hesc() every name — these come straight from admin bulk-import Excel
    // sheets into the evaluators table with no server-side sanitization, so
    // a crafted name would otherwise execute as script the moment this
    // dropdown renders in an admin's own session.
    const opts = (list) => '<option value="">— unassigned (nobody can rate/approve) —</option>' +
      list.map(p => `<option value="${p.id}" data-team="${hesc(p.team)}">${hesc(p.name)} (${hesc(p.team)})</option>`).join('');

    const wrap = overlay('Assign PO Rating', `
      ${field('PO Number *', 'as-num', 'placeholder="Exact PO number, e.g. BG/BG24M782/POD/26/000200"')}
      <label style="display:block;font-size:12px;color:#555;margin-top:10px;">Category *</label>
      <select id="as-cat" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:5px;">
        ${CATEGORIES.map(c => `<option value="${c}">${c.toUpperCase()}</option>`).join('')}
      </select>
      <label style="display:block;font-size:12px;color:#555;margin-top:10px;">Period *</label>
      <select id="as-period" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:5px;">
        <option value="H1">H1</option><option value="H2">H2</option>
      </select>
      <label style="display:block;font-size:12px;color:#555;margin-top:10px;">Evaluator</label>
      <select id="as-eval" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:5px;">${opts(evaluators)}</select>
      <label style="display:block;font-size:12px;color:#555;margin-top:10px;">Approver</label>
      <select id="as-appr" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:5px;">${opts(approvers)}</select>
    `, async (w) => {
      const poNumber = val(w, 'as-num');
      if (!poNumber) throw new Error('Enter the PO number to assign.');

      const poRow = DB['api::pos']?.rows.find(r => r.poNum === poNumber);
      if (!poRow?._poId) throw new Error(`Could not find PO "${poNumber}" — check the number is exact.`);

      const category = w.querySelector('#as-cat').value;
      const period = w.querySelector('#as-period').value;
      const evaluator_id = w.querySelector('#as-eval').value || null;
      const approver_id = w.querySelector('#as-appr').value || null;

      const res = await window.apiFetch('/api/assignments', {
        method: 'POST',
        body: JSON.stringify({ po_id: poRow._poId, category, period, evaluator_id, approver_id }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

      toast(`Assignment saved for PO ${poNumber} (${category.toUpperCase()} ${period}) ✓`, 'ok');
    });
  }

  // ---- Bulk Import (Excel) --------------------------------------------
  // Expected columns (case-insensitive, extra columns ignored):
  //   PO NUMBER *, VENDOR CODE *, VENDOR NAME, JOB CODE, JOB DESC, PO VALUE,
  //   CURRENCY, PO DATE, DELIVERY START DATE, DELIVERY END DATE, BUYER, BU,
  //   SBU, PAYMENT TERMS, PO STATUS,
  //   SCM EVALUATOR, SCM APPROVER, EDRC EVALUATOR, EDRC APPROVER,
  //   QUALITY EVALUATOR, QUALITY APPROVER, OPERATION EVALUATOR, OPERATION APPROVER
  // Any of the 8 name columns may be blank — that team's assignment for this
  // PO is simply left untouched (or unset, if it's a brand-new PO).
  const BULK_HEADER_ALIASES = {
    'PO NUMBER': 'po_number', 'VENDOR CODE': 'vendor_code', 'VENDOR NAME': 'vendor_name', 'VENDOR DESC': 'vendor_name',
    'JOB CODE': 'job_code', 'JOB DESC': 'job_desc', 'JOB DESCRIPTION': 'job_desc',
    'PO VALUE': 'po_value', 'CURRENCY': 'currency', 'CURRENCY DESC': 'currency',
    'PO DATE': 'po_date', 'DELIVERY START DATE': 'delivery_start_date', 'DELIVERY END DATE': 'delivery_end_date',
    'BUYER': 'buyer', 'BU': 'bu', 'SBU': 'sbu', 'PAYMENT TERMS': 'payment_terms', 'PAYMENTTERMS': 'payment_terms',
    'PO STATUS': 'po_status',
    'SCM EVALUATOR': 'scm_evaluator', 'SCM APPROVER': 'scm_approver',
    'EDRC EVALUATOR': 'edrc_evaluator', 'EDRC APPROVER': 'edrc_approver',
    'QUALITY EVALUATOR': 'quality_evaluator', 'QUALITY APPROVER': 'quality_approver',
    'OPERATION EVALUATOR': 'operation_evaluator', 'OPERATION APPROVER': 'operation_approver',
    'OPERATIONS EVALUATOR': 'operation_evaluator', 'OPERATIONS APPROVER': 'operation_approver',
  };

  function bulkCellText(v) { return v == null ? '' : String(v).trim(); }

  // Excel serial date -> 'YYYY-MM-DD'; passes real Date objects and plain
  // strings through XLSX's own date parsing/formatting where possible.
  function bulkCellDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    if (typeof v === 'number' && window.XLSX && XLSX.SSF) {
      const p = XLSX.SSF.parse_date_code(v);
      if (p) return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }
    const d = new Date(bulkCellText(v));
    return isNaN(d.getTime()) ? bulkCellText(v) : d.toISOString().slice(0, 10);
  }

  // Parses the workbook's first sheet into { rows, warnings }. rows are
  // shaped exactly as POST /api/pos/bulk-import expects.
  function parseBulkWorkbook(workbook) {
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(
      typeof trimSheetRange === 'function' ? trimSheetRange(sheet) : sheet,
      { header: 1, defval: '' }
    );
    if (!raw.length) return { rows: [], warnings: ['The sheet appears to be empty.'] };

    const headerRow = raw[0].map(h => bulkCellText(h).toUpperCase());
    const colIndex = {};
    headerRow.forEach((h, i) => {
      const mapped = BULK_HEADER_ALIASES[h];
      if (mapped && colIndex[mapped] === undefined) colIndex[mapped] = i;
    });
    const warnings = [];
    if (colIndex.po_number === undefined) warnings.push('No "PO NUMBER" column found — every row will be skipped.');
    if (colIndex.vendor_code === undefined) warnings.push('No "VENDOR CODE" column found — every row will be skipped.');

    const dataRows = raw.slice(1).filter(r => r.some(v => bulkCellText(v)));
    const get = (r, key) => (colIndex[key] === undefined ? '' : r[colIndex[key]]);
    const rows = dataRows.map(r => ({
      po_number: bulkCellText(get(r, 'po_number')),
      vendor_code: bulkCellText(get(r, 'vendor_code')),
      vendor_name: bulkCellText(get(r, 'vendor_name')),
      job_code: bulkCellText(get(r, 'job_code')),
      job_desc: bulkCellText(get(r, 'job_desc')),
      po_value: Number(get(r, 'po_value')) || 0,
      currency: bulkCellText(get(r, 'currency')),
      po_date: bulkCellDate(get(r, 'po_date')),
      delivery_start_date: bulkCellDate(get(r, 'delivery_start_date')),
      delivery_end_date: bulkCellDate(get(r, 'delivery_end_date')),
      buyer: bulkCellText(get(r, 'buyer')),
      bu: bulkCellText(get(r, 'bu')),
      sbu: bulkCellText(get(r, 'sbu')),
      payment_terms: bulkCellText(get(r, 'payment_terms')),
      po_status: bulkCellText(get(r, 'po_status')),
      assignments: {
        scm: { evaluator: bulkCellText(get(r, 'scm_evaluator')), approver: bulkCellText(get(r, 'scm_approver')) },
        edrc: { evaluator: bulkCellText(get(r, 'edrc_evaluator')), approver: bulkCellText(get(r, 'edrc_approver')) },
        quality: { evaluator: bulkCellText(get(r, 'quality_evaluator')), approver: bulkCellText(get(r, 'quality_approver')) },
        operation: { evaluator: bulkCellText(get(r, 'operation_evaluator')), approver: bulkCellText(get(r, 'operation_approver')) },
      },
    }));
    return { rows, warnings };
  }

  function bulkResultsModal(period, summary) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    const { stats, createdAccounts, errors } = summary;

    const statLine = (label, val) => `<div style="flex:1;min-width:110px;"><div style="font-size:22px;font-weight:700;color:#1b2027;">${val}</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.4px;">${label}</div></div>`;

    const accountsSection = createdAccounts.length ? `
      <div style="margin-top:16px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#a11;">⚠ New login accounts created — copy these now, they cannot be shown again:</div>
        <div style="max-height:180px;overflow:auto;border:1px solid #e0c;border-color:#e6c200;border-radius:6px;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="background:#fff8e1;"><th style="text-align:left;padding:6px 8px;">Name</th><th style="text-align:left;padding:6px 8px;">Role/Team</th><th style="text-align:left;padding:6px 8px;">Username</th><th style="text-align:left;padding:6px 8px;">Temp Password</th></tr></thead>
            <tbody>${createdAccounts.map(a => `<tr style="border-top:1px solid #eee;">
              <td style="padding:6px 8px;">${hesc(a.name)}</td>
              <td style="padding:6px 8px;">${hesc(a.role)}/${hesc(a.team)}</td>
              <td style="padding:6px 8px;font-family:monospace;">${hesc(a.username)}</td>
              <td style="padding:6px 8px;font-family:monospace;font-weight:700;">${hesc(a.tempPassword)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : '';

    const errorsSection = errors.length ? `
      <div style="margin-top:16px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#a11;">${errors.length} row issue${errors.length === 1 ? '' : 's'}:</div>
        <div style="max-height:140px;overflow:auto;border:1px solid #eee;border-radius:6px;padding:8px 10px;font-size:12px;color:#a11;background:#fff5f5;">
          ${errors.map(e => `<div style="margin-bottom:4px;">${hesc(e)}</div>`).join('')}
        </div>
      </div>` : '';

    wrap.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:26px;width:560px;max-width:92vw;max-height:88vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.35);">
        <h3 style="margin:0 0 4px;font-size:16px;">Bulk Import Complete — ${period}</h3>
        <p style="margin:0 0 16px;font-size:12px;color:#666;">Everyone assigned below can now see this in their My Ratings / My Approvals queue.</p>
        <div style="display:flex;gap:14px;flex-wrap:wrap;padding:14px;background:#f6f8fa;border-radius:8px;">
          ${statLine('Vendors upserted', stats.vendorsUpserted)}
          ${statLine('POs created', stats.posCreated)}
          ${statLine('POs updated', stats.posUpdated)}
          ${statLine('Assignments set', stats.assignmentsUpserted)}
          ${statLine('New accounts', createdAccounts.length)}
        </div>
        ${accountsSection}
        ${errorsSection}
        <div style="display:flex;gap:8px;margin-top:20px;">
          <button type="button" id="bulk-results-close" style="flex:1;padding:9px;border:none;background:#0072bc;color:#fff;border-radius:6px;font-weight:600;cursor:pointer;">Done</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#bulk-results-close').onclick = () => wrap.remove();
  }

  function openBulkImport() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
    wrap.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:26px;width:460px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.35);">
        <h3 style="margin:0 0 6px;font-size:16px;">Bulk Import POs + Assignments</h3>
        <p style="margin:0 0 16px;font-size:12px;color:#666;line-height:1.5;">
          Upload an Excel sheet with one row per PO. Required columns: <strong>PO NUMBER</strong>, <strong>VENDOR CODE</strong>.
          Optional per-team columns: <strong>SCM/EDRC/QUALITY/OPERATION EVALUATOR</strong> and <strong>...APPROVER</strong> (exact names — a name with no matching login gets a new account created automatically).
        </p>
        <label style="display:block;font-size:12px;color:#555;">Applies to period *</label>
        <select id="bi-period" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:5px;">
          <option value="H1">H1</option><option value="H2">H2</option>
        </select>
        <label style="display:block;font-size:12px;color:#555;margin-top:12px;">Excel file (.xlsx) *</label>
        <input id="bi-file" type="file" accept=".xlsx,.xls" style="width:100%;margin-top:4px;">
        <div id="bi-preview" style="margin-top:10px;font-size:12px;color:#666;"></div>
        <div id="bi-error" style="margin-top:10px;color:#a11;font-size:12px;"></div>
        <div style="display:flex;gap:8px;margin-top:18px;">
          <button type="button" id="bi-cancel" style="flex:1;padding:9px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer;">Cancel</button>
          <button type="button" id="bi-submit" style="flex:1;padding:9px;border:none;background:#0072bc;color:#fff;border-radius:6px;font-weight:600;cursor:pointer;">Import</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let parsedRows = null;
    const fileEl = wrap.querySelector('#bi-file');
    const previewEl = wrap.querySelector('#bi-preview');
    const errEl = wrap.querySelector('#bi-error');

    fileEl.addEventListener('change', () => {
      parsedRows = null;
      previewEl.textContent = '';
      errEl.textContent = '';
      const file = fileEl.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const workbook = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
          const { rows, warnings } = parseBulkWorkbook(workbook);
          parsedRows = rows;
          const assignmentCount = rows.reduce((n, r) => n + Object.values(r.assignments).filter(a => a.evaluator || a.approver).length, 0);
          previewEl.innerHTML = warnings.length
            ? `<span style="color:#a11;">${warnings.join(' ')}</span>`
            : `Found <strong>${rows.length}</strong> PO row(s) with <strong>${assignmentCount}</strong> team assignment(s) to set.`;
        } catch (e) {
          errEl.textContent = 'Could not read this file: ' + e.message;
        }
      };
      reader.readAsArrayBuffer(file);
    });

    wrap.querySelector('#bi-cancel').onclick = () => wrap.remove();
    wrap.querySelector('#bi-submit').onclick = async () => {
      errEl.textContent = '';
      if (!parsedRows || !parsedRows.length) { errEl.textContent = 'Choose a valid Excel file first.'; return; }
      const period = wrap.querySelector('#bi-period').value;
      const submitBtn = wrap.querySelector('#bi-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Importing…';
      try {
        const res = await window.apiFetch('/api/pos/bulk-import', {
          method: 'POST',
          body: JSON.stringify({ period, rows: parsedRows }),
        });
        const data = await safeJson(res);
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

        wrap.remove();
        bulkResultsModal(period, data);
        if (typeof window.loadDataFromAPI === 'function') window.loadDataFromAPI();
      } catch (e) {
        errEl.textContent = e.message || 'Import failed.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Import';
      }
    };
  }

  function injectButtons() {
    if (!window.AUTH || window.AUTH.user.role !== 'admin') return;

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add PO';
    addBtn.style.cssText = 'position:fixed;bottom:20px;right:170px;z-index:9999;padding:10px 16px;background:#1a7f37;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    addBtn.onclick = openAddPo;
    document.body.appendChild(addBtn);

    const assignBtn = document.createElement('button');
    assignBtn.textContent = 'Assign PO';
    assignBtn.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9999;padding:10px 16px;background:#6f42c1;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    assignBtn.onclick = openAssignPo;
    document.body.appendChild(assignBtn);

    const bulkBtn = document.createElement('button');
    bulkBtn.textContent = '📤 Bulk Import (Excel)';
    bulkBtn.style.cssText = 'position:fixed;bottom:20px;left:130px;z-index:9999;padding:10px 16px;background:#9a6a07;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    bulkBtn.onclick = openBulkImport;
    document.body.appendChild(bulkBtn);
  }

  document.addEventListener('vpr-auth-ready', injectButtons);
})();
