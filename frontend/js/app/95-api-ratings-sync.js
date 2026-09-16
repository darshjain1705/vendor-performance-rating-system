/* ============================================================
 * 95-api-ratings-sync.js
 * Draft-and-save synchronization for ratings.
 * Star clicks update the local draft only. The evaluator/approver explicitly
 * presses Save Ratings to persist the complete category and remarks once.
 * ============================================================ */
(function () {
  const originalSaveRating = window.saveRating;
  const pending = new Map();
  window.VPR_PENDING_RATING_EDITS = pending;
  window.VPR_PENDING_REMARKS = window.VPR_PENDING_REMARKS || {};

  function currentContext(category) {
    const keyMatch = activeRatingKey ? activeRatingKey.match(/^po:([^|]*)\|/) : null;
    const poNumber = keyMatch ? keyMatch[1] : null;
    const poRow = poNumber && DB['api::pos'] ? DB['api::pos'].rows.find(r => r.poNum === poNumber) : null;
    return { poNumber, poId: poRow ? poRow._poId : null, category, period: activeQuarter };
  }
  function editKey(ctx, parameter) { return `${ctx.poId}|${ctx.category}|${ctx.period}|${parameter}`; }
  function blockKey(ctx) { return `${ctx.poId}|${ctx.category}|${ctx.period}`; }
  function setSaveState(text, kind) {
    const el = document.getElementById('rating-save-state');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'error' ? '#a82f1c' : kind === 'ok' ? '#1e7d34' : 'var(--t3)';
  }
  function refreshDraftIndicator(category) {
    const ctx = currentContext(category);
    const count = ctx.poId ? [...pending.keys()].filter(k => k.startsWith(`${ctx.poId}|${ctx.category}|${ctx.period}|`)).length : 0;
    const btn = document.getElementById('rating-save-btn');
    if (btn) {
      btn.disabled = count === 0 && !window.VPR_PENDING_REMARKS[blockKey(ctx)];
      btn.textContent = count ? `Save Ratings (${count} change${count === 1 ? '' : 's'})` : 'Save Ratings';
    }
    if (count || window.VPR_PENDING_REMARKS[blockKey(ctx)]) setSaveState(`${count} unsaved rating change${count === 1 ? '' : 's'} — save when ready`, 'draft');
  }
  window.refreshRatingDraftIndicator = refreshDraftIndicator;
  window.categoryHasPendingChanges = function (category) {
    const ctx = currentContext(category);
    return !!ctx.poId && ([...pending.keys()].some(k => k.startsWith(`${ctx.poId}|${category}|${ctx.period}|`)) || !!window.VPR_PENDING_REMARKS[blockKey(ctx)]);
  };
  window.addEventListener('beforeunload', function (event) {
    if (pending.size || Object.keys(window.VPR_PENDING_REMARKS).length) {
      event.preventDefault();
      event.returnValue = 'You have unsaved rating changes.';
    }
  });

  window.saveRating = function (key, val) {
    const paramMatch = key.match(/^([a-z]+)_(\d+)$/);
    const category = paramMatch ? paramMatch[1] : null;
    const ctx = currentContext(category);
    if (category && window.canEditCategoryForPO && !window.canEditCategoryForPO(category, ctx.poId, activeQuarter)) {
      const teamMsg = window.AUTH && window.AUTH.user.team ? window.AUTH.user.team.toUpperCase() : 'your team';
      if (typeof toast === 'function') toast(`Not assigned to you — you can't rate ${category.toUpperCase()} for this PO (${teamMsg} only touches its own assigned POs)`, 'err');
      return;
    }
    // Original save updates the draft/UI immediately without a network request.
    originalSaveRating(key, val);
    if (!ctx.poId || !window.AUTH || !paramMatch) return;
    pending.set(editKey(ctx, key), { ...ctx, parameter_code: key, score: val });
    refreshDraftIndicator(category);
    setSaveState('Draft updated locally — not yet saved', 'draft');
  };

  window.saveItemName = async function (poId, period) {
    const input = document.getElementById('po-item-name');
    if (!input || !window.AUTH) return;
    const btn = document.getElementById('po-item-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    const newName = String(input.value || '').trim();

    try {
      const res = await window.apiFetch(`/api/pos/${poId}/item`, {
        method: 'PATCH',
        body: JSON.stringify({ item_name: newName, period })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

      // Patch local PO row + item maps immediately so the detail header shows
      // the new name without requiring a full page reload.
      if (typeof DB !== 'undefined' && DB['api::pos'] && Array.isArray(DB['api::pos'].rows)) {
        const poRow = DB['api::pos'].rows.find(r => String(r._poId) === String(poId));
        if (poRow) {
          poRow.item = newName;
          if (typeof PO_ITEM_MAP !== 'undefined') {
            const poKey = poRow.poNum || '';
            if (poKey) {
              PO_ITEM_MAP[`H1|${poKey}`] = newName;
              PO_ITEM_MAP[`H2|${poKey}`] = newName;
            }
          }
        }
      }

      if (typeof toast === 'function') toast('Item name updated ✓', 'ok');
      if (btn) { btn.textContent = 'Updated!'; setTimeout(() => btn.textContent = 'Update Item', 2000); }

      if (typeof window.rCategoryDetail === 'function' && window._lastCategoryDetailId) {
        window.rCategoryDetail(window._lastCategoryDetailId);
      }
    } catch (e) {
      if (typeof toast === 'function') toast(e.message || 'Failed to save item name', 'err');
      if (btn) btn.textContent = 'Update Item';
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.saveCurrentCategory = async function (category) {
    const ctx = currentContext(category);
    if (!ctx.poId || !window.AUTH) {
      setSaveState('Open a database PO and sign in before saving.', 'error');
      return;
    }
    const edits = [...pending.values()].filter(e => e.poId === ctx.poId && e.category === category && e.period === ctx.period);
    const remarkKey = blockKey(ctx);
    const remark = Object.prototype.hasOwnProperty.call(window.VPR_PENDING_REMARKS, remarkKey)
      ? window.VPR_PENDING_REMARKS[remarkKey] : null;
    if (!edits.length && remark == null) {
      setSaveState('No unsaved changes.', 'ok');
      return;
    }
    const btn = document.getElementById('rating-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    setSaveState('Saving ratings and remarks…', 'draft');
    try {
      for (const edit of edits) {
        const res = await window.apiFetch('/api/ratings', {
          method: 'POST',
          body: JSON.stringify({
            po_id: edit.poId, category: edit.category, period: edit.period,
            parameter_code: edit.parameter_code, score: edit.score, status: 'rated',
            change_reason: window.VPR_APPROVER_CHANGE_REASON || null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      }
      if (remark != null) {
        const res = await window.apiFetch('/api/ratings/remark', {
          method: 'POST',
          body: JSON.stringify({ po_id: ctx.poId, category, period: ctx.period, remarks: remark }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      }
      edits.forEach(e => pending.delete(editKey(e, e.parameter_code)));
      delete window.VPR_PENDING_REMARKS[remarkKey];
      if (typeof window.hydrateRatingsFromAPI === 'function' && DB['api::pos']) {
        await window.hydrateRatingsFromAPI(DB['api::pos'].rows);
      }
      document.dispatchEvent(new CustomEvent('vpr-data-refreshed'));
      setSaveState('Saved successfully. Awaiting approval where required.', 'ok');
      if (typeof toast === 'function') toast(`${edits.length} rating${edits.length === 1 ? '' : 's'} saved successfully`, 'ok');
      if (typeof window.rCategoryDetail === 'function' && activeRatingKey) window.rCategoryDetail(category);
    } catch (err) {
      console.error('[ratings-sync] Failed to save category:', err);
      setSaveState('Save failed — your draft is still preserved. ' + err.message, 'error');
      if (typeof toast === 'function') toast('Ratings not saved: ' + err.message, 'err');
      refreshDraftIndicator(category);
    }
  };
})();
