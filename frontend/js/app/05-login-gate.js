/* ============================================================
 * 05-login-gate.js
 * MUST be the FIRST script tag in vendor_rating.html.
 *
 * Blocks the whole page behind a login form until a valid token
 * is confirmed with the backend. Once logged in, exposes:
 *   window.AUTH        -> { token, user: {id, username, name, role, team} }
 *   window.apiFetch(path, opts) -> fetch() that auto-attaches the
 *                                   Authorization header
 * and then calls window.loadDataFromAPI() (defined in
 * 25-api-loader.js) to actually load vendors/POs.
 *
 * The token is kept in localStorage so a page refresh doesn't force
 * a re-login — but it's re-verified against the server every time
 * (a token can't just be trusted because it's sitting in storage;
 * it could be expired or the account could have been deactivated).
 *
 * Uses the app's own design tokens (css/20-skin.css --acc/--navy/etc.,
 * already loaded in <head> before this script runs) so the gate looks
 * like part of the product, not a bolted-on dialog, and follows the
 * same light/dark theme switch as the rest of the dashboard.
 * ============================================================ */

const API_BASE = 'http://localhost:5000';

window.AUTH = null;

window.apiFetch = function (path, opts = {}) {
  const headers = Object.assign({}, opts.headers, {
    'Content-Type': 'application/json',
    ...(window.AUTH ? { Authorization: 'Bearer ' + window.AUTH.token } : {}),
  });
  return fetch(API_BASE + path, { ...opts, headers });
};

// ---- Team/category-level checks (coarse) --------------------------------
// Whether the signed-in user's ROLE+TEAM even makes them a candidate to edit
// this category ('scm' | 'edrc' | 'quality' | 'operation') — ignores which
// specific PO is involved. Used only as a fallback where no PO is in scope
// yet (e.g. a list view before a specific item is opened); the real,
// PO-aware answer is canEditCategoryForPO()/canApproveCategoryForPO() below,
// which is what actually gates the star clicks. Not logged in (no
// window.AUTH — e.g. viewing the static file directly without the backend)
// leaves everything editable, same as before login was added.
window.canEditCategory = function (catId) {
  if (!window.AUTH) return true;
  const user = window.AUTH.user;
  if (user.role === 'admin') return true;
  return (user.role === 'evaluator' || user.role === 'approver') && user.team === catId;
};

window.canApproveCategory = function (catId) {
  if (!window.AUTH) return true;
  const user = window.AUTH.user;
  if (user.role === 'admin') return true;
  return user.role === 'approver' && user.team === catId;
};

// ---- PO-scoped checks (the real rule) ------------------------------------
// window.PO_ASSIGNMENTS / window.PO_REJECTED are populated by
// hydrateRatingsFromAPI() in 25-api-loader.js from /api/assignments and
// /api/ratings respectively, and mirror exactly what the server's
// canEvaluate()/canApprove()/canEditRatingValue() in middleware/auth.js
// checks — there is no team-wide fallback: an admin must have explicitly
// assigned this PO/category/period to this exact person.
window.getAssignmentFor = function (poId, catId, period) {
  if (!poId || !window.PO_ASSIGNMENTS) return null;
  return window.PO_ASSIGNMENTS[`${poId}|${catId}|${period}`] || null;
};

// Whether the signed-in user may edit the star ratings and remarks for this
// exact PO's category+period block. The assigned evaluator may always revise
// their own submission. Each revision resets the block to Pending Review on
// the server, so the approver must make a fresh decision.
//   - approver: only once they've set 'Rejected' ("Not Approved and
//     Changed") on this block — approving is a decision, not a licence to
//     freely edit scores; setting 'Approved' locks them out too.
window.canEditCategoryForPO = function (catId, poId, period) {
  if (!window.AUTH) return true; // no backend/login — local-only sandbox, unchanged
  const user = window.AUTH.user;
  if (user.role === 'admin') return true;
  if (user.team !== catId) return false;
  if (!poId) return false; // no PO in scope yet — nothing to check against, default closed
  const a = window.getAssignmentFor(poId, catId, period);
  if (!a) return false; // no explicit assignment — nobody on the team may touch it
  const key = `${poId}|${catId}|${period}`;
  const isRejected = !!(window.PO_REJECTED && window.PO_REJECTED.has(key));
  // NULL evaluator_id / approver_id means "whole team" (Assign PO left person blank).
  if (user.role === 'evaluator') return a.evaluator_id == null || a.evaluator_id === user.id;
  if (user.role === 'approver') return (a.approver_id == null || a.approver_id === user.id) && isRejected;
  return false;
};

// Whether the signed-in user may mark this block "NA — Not Applicable". A
// status decision, not a score edit, so it's independent of the
// approved/rejected edit-lock above: either the assigned evaluator (the
// normal "this doesn't apply, nothing to rate" call) or the assigned
// approver/admin — mirrors the server's canSetNA in middleware/auth.js.
window.canSetNAForPO = function (catId, poId, period) {
  if (!window.AUTH) return true;
  const user = window.AUTH.user;
  if (user.role === 'admin') return true;
  if (user.team !== catId || !poId) return false;
  const a = window.getAssignmentFor(poId, catId, period);
  if (!a) return false;
  if (user.role === 'evaluator') return a.evaluator_id == null || a.evaluator_id === user.id;
  if (user.role === 'approver') return a.approver_id == null || a.approver_id === user.id;
  return false;
};

// An evaluator may undo their own NA decision and return the block to Pending
// Review. This is intentionally not an approver decision.
window.canResetToPendingForPO = function (catId, poId, period) {
  if (!window.AUTH) return true;
  const user = window.AUTH.user;
  if (user.role === 'admin') return true;
  if (user.role !== 'evaluator' || user.team !== catId || !poId) return false;
  const a = window.getAssignmentFor(poId, catId, period);
  return !!a && (a.evaluator_id == null || a.evaluator_id === user.id);
};

// Whether the signed-in user may approve/reject this exact PO's category+period block.
// NULL approver_id = whole-team approver (any approver on that team).
window.canApproveCategoryForPO = function (catId, poId, period) {
  if (!window.AUTH) return true;
  const user = window.AUTH.user;
  if (user.role === 'admin') return true;
  if (user.role !== 'approver' || user.team !== catId) return false;
  if (!poId) return false;
  const a = window.getAssignmentFor(poId, catId, period);
  return !!a && (a.approver_id == null || a.approver_id === user.id);
};

(function () {
  const LAST_USER_KEY = 'vpr_last_username';

  const style = document.createElement('style');
  style.textContent = `
    #login-gate {
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      padding: 24px; box-sizing: border-box;
      font-family: var(--fn, system-ui, sans-serif);
      background:
        radial-gradient(1100px 560px at 12% -8%, rgba(31,111,235,.35), transparent 60%),
        radial-gradient(900px 500px at 100% 108%, rgba(14,116,144,.30), transparent 55%),
        var(--navy, #10151c);
      animation: lg-fade-in .35s var(--ease-out, ease) both;
    }
    @keyframes lg-fade-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes lg-rise { from { opacity: 0; transform: translateY(10px) scale(.98) } to { opacity: 1; transform: translateY(0) scale(1) } }
    @keyframes lg-spin { to { transform: rotate(360deg) } }
    @keyframes lg-shake {
      10%, 90% { transform: translateX(-1px); }
      20%, 80% { transform: translateX(2px); }
      30%, 50%, 70% { transform: translateX(-4px); }
      40%, 60% { transform: translateX(4px); }
    }

    #login-gate .lg-card {
      width: 100%; max-width: 380px;
      background: var(--s1, #fff);
      border: 1px solid var(--brd2, #c2ccd6);
      border-radius: var(--r-lg, 10px);
      box-shadow: var(--shadow-lg, 0 24px 56px -20px rgba(11,21,36,.45));
      padding: 30px 30px 26px;
      box-sizing: border-box;
      animation: lg-rise .4s var(--ease-out, cubic-bezier(.22,.9,.3,1)) both;
    }
    #login-gate .lg-card.lg-shake { animation: lg-shake .4s linear; }

    #login-gate .lg-brand {
      display: flex; align-items: center; gap: 12px; margin-bottom: 22px;
    }
    #login-gate .lg-mark {
      width: 40px; height: 40px; border-radius: 9px; flex: none;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, var(--acc, #1f6feb), var(--cyan, #0e7490));
      color: #fff; font-family: var(--hd, sans-serif); font-weight: 700;
      font-size: 15px; letter-spacing: .3px; box-shadow: 0 6px 16px -6px rgba(31,111,235,.55);
    }
    #login-gate .lg-brand-text { min-width: 0; }
    #login-gate .lg-eyebrow {
      font-family: var(--hd, sans-serif); font-size: 10.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1.4px; color: var(--acc, #1f6feb);
      margin: 0 0 2px;
    }
    #login-gate .lg-title {
      font-family: var(--hd, sans-serif); font-size: 19px; font-weight: 700;
      color: var(--txt, #151a20); margin: 0; line-height: 1.2;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    #login-gate form { margin: 0; }
    #login-gate .lg-field { margin-bottom: 16px; }
    #login-gate .lg-field label {
      display: block; font-size: 11.5px; font-weight: 600; color: var(--t3, #6b7885);
      text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px;
    }
    #login-gate .lg-input-wrap { position: relative; }
    #login-gate .lg-input-wrap svg {
      position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
      color: var(--t3, #6b7885); pointer-events: none;
    }
    #login-gate input[type="text"], #login-gate input[type="password"] {
      width: 100%; box-sizing: border-box;
      padding: 11px 12px 11px 38px;
      font-family: var(--fn, sans-serif); font-size: 14px; color: var(--txt, #151a20);
      background: var(--s2, #f7f9fb); border: 1px solid var(--brd2, #c2ccd6);
      border-radius: var(--r, 6px);
      outline: none; transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
    }
    #login-gate input::placeholder { color: var(--t4, #96a3af); }
    #login-gate input:hover { border-color: var(--brd3, #8593a1); }
    #login-gate input:focus {
      background: var(--s1, #fff);
      border-color: var(--acc, #1f6feb);
      box-shadow: 0 0 0 3px var(--acc-lt, #e8f0fe);
    }
    #login-gate input:disabled { opacity: .6; cursor: not-allowed; }
    #login-gate .lg-pass-toggle {
      position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
      width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 6px; cursor: pointer;
      color: var(--t3, #6b7885);
    }
    #login-gate .lg-pass-toggle:hover { background: var(--s3, #e7ecf1); color: var(--txt, #151a20); }

    #login-gate .lg-row { display: flex; align-items: center; justify-content: space-between; margin: -4px 0 18px; }
    #login-gate .lg-remember { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--t3, #6b7885); user-select: none; cursor: pointer; }
    #login-gate .lg-remember input { accent-color: var(--acc, #1f6feb); width: 14px; height: 14px; cursor: pointer; }

    #login-gate button#lg-submit {
      width: 100%; padding: 11px; border: none; border-radius: var(--r, 6px);
      background: var(--acc, #1f6feb); color: #fff;
      font-family: var(--fn, sans-serif); font-size: 13.5px; font-weight: 700;
      letter-spacing: .2px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      transition: background .14s ease, transform .1s ease, box-shadow .14s ease;
      box-shadow: 0 6px 16px -8px rgba(31,111,235,.6);
    }
    #login-gate button#lg-submit:hover:not(:disabled) { background: var(--acc2, #1550b3); }
    #login-gate button#lg-submit:active:not(:disabled) { transform: translateY(1px); }
    #login-gate button#lg-submit:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; }
    #login-gate .lg-spinner {
      width: 15px; height: 15px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
      animation: lg-spin .7s linear infinite; flex: none;
    }

    #login-gate #lg-error {
      display: none; align-items: flex-start; gap: 8px;
      margin-top: 14px; padding: 10px 12px;
      background: var(--red-lt, #fbe9e6); border: 1px solid var(--red-brd, #e6aca4);
      border-radius: var(--r, 6px); color: var(--red, #b3291d);
      font-size: 12.5px; line-height: 1.45;
    }
    #login-gate #lg-error.lg-show { display: flex; }
    #login-gate #lg-error svg { flex: none; margin-top: 1px; }

    #login-gate .lg-footer {
      margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--brd, #dde3ea);
      font-size: 11px; color: var(--t4, #96a3af); text-align: center; line-height: 1.6;
    }

    /* Full-screen "restoring your session" state shown while a saved token
       is re-verified against the server — replaces the old behaviour where
       the empty login form flashed on screen before being removed. */
    #login-gate .lg-restoring {
      display: flex; flex-direction: column; align-items: center; gap: 14px;
      color: var(--white, #fff); text-align: center;
    }
    #login-gate .lg-restoring .lg-spinner {
      width: 26px; height: 26px; border-width: 3px;
      border-color: rgba(255,255,255,.25); border-top-color: #fff;
    }
    #login-gate .lg-restoring span { font-size: 12.5px; letter-spacing: .3px; opacity: .85; }

    @media (max-width: 420px) {
      #login-gate .lg-card { padding: 24px 20px 20px; }
    }
  `;
  document.head.appendChild(style);

  const ICONS = {
    user: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    lock: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    eye: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.4 21.4 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.4 21.4 0 0 1-2.61 3.87M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>`,
    warn: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  };

  const overlay = document.createElement('div');
  overlay.id = 'login-gate';
  overlay.innerHTML = `
    <div class="lg-card" id="lg-card">
      <div class="lg-brand">
        <div class="lg-mark">BG</div>
        <div class="lg-brand-text">
          <p class="lg-eyebrow">BrightGrid Renewable Energy</p>
          <h2 class="lg-title">Vendor Rating Dashboard</h2>
        </div>
      </div>
      <form id="lg-form" autocomplete="on" novalidate>
        <div class="lg-field">
          <label for="lg-user">Username</label>
          <div class="lg-input-wrap">
            ${ICONS.user}
            <input id="lg-user" type="text" name="username" placeholder="e.g. scm_eval" autocomplete="username" autocapitalize="none" spellcheck="false">
          </div>
        </div>
        <div class="lg-field">
          <label for="lg-pass">Password</label>
          <div class="lg-input-wrap">
            ${ICONS.lock}
            <input id="lg-pass" type="password" name="password" placeholder="••••••••" autocomplete="current-password">
            <button type="button" class="lg-pass-toggle" id="lg-pass-toggle" tabindex="-1" aria-label="Show password">${ICONS.eye}</button>
          </div>
        </div>
        <div class="lg-row">
          <label class="lg-remember"><input type="checkbox" id="lg-remember"> Remember my username</label>
        </div>
        <button type="submit" id="lg-submit">
          <span id="lg-submit-label">Sign In</span>
        </button>
        <div id="lg-error" role="alert" aria-live="polite"></div>
      </form>
      <div class="lg-footer">Sign in with the credentials issued by your administrator.</div>
    </div>
  `;

  function setBusy(busy) {
    const btn = document.getElementById('lg-submit');
    const label = document.getElementById('lg-submit-label');
    const userEl = document.getElementById('lg-user');
    const passEl = document.getElementById('lg-pass');
    btn.disabled = busy;
    userEl.disabled = busy;
    passEl.disabled = busy;
    label.innerHTML = busy ? `<span class="lg-spinner"></span> Signing in…` : 'Sign In';
  }

  function showError(msg) {
    const errEl = document.getElementById('lg-error');
    errEl.innerHTML = `${ICONS.warn}<span>${msg}</span>`;
    errEl.classList.add('lg-show');
    const card = document.getElementById('lg-card');
    card.classList.remove('lg-shake');
    // restart the shake animation even if it's already mid-flight
    void card.offsetWidth;
    card.classList.add('lg-shake');
  }

  function clearError() {
    const errEl = document.getElementById('lg-error');
    errEl.classList.remove('lg-show');
    errEl.textContent = '';
  }

  function mountOverlay() {
    document.body.appendChild(overlay);

    const savedUser = localStorage.getItem(LAST_USER_KEY);
    if (savedUser) {
      document.getElementById('lg-user').value = savedUser;
      document.getElementById('lg-remember').checked = true;
    }

    document.getElementById('lg-form').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
    document.getElementById('lg-pass-toggle').addEventListener('click', () => {
      const passEl = document.getElementById('lg-pass');
      const toggleBtn = document.getElementById('lg-pass-toggle');
      const showing = passEl.type === 'text';
      passEl.type = showing ? 'password' : 'text';
      toggleBtn.innerHTML = showing ? ICONS.eye : ICONS.eyeOff;
      toggleBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
    [document.getElementById('lg-user'), document.getElementById('lg-pass')].forEach(el => {
      el.addEventListener('input', clearError);
    });

    (savedUser ? document.getElementById('lg-pass') : document.getElementById('lg-user')).focus();
  }

  async function doLogin() {
    const username = document.getElementById('lg-user').value.trim();
    const password = document.getElementById('lg-pass').value;
    clearError();

    if (!username || !password) {
      showError('Enter both your username and password.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Invalid username or password.');
        setBusy(false);

        // 423 = account locked (too many failed attempts) or 429 = this
        // network is rate-limited. Either way, retrying immediately can't
        // succeed, so keep Sign In disabled instead of inviting a pointless
        // (and, for the lockout case, self-defeating) resubmit. If the
        // server told us exactly when the lock lifts, re-enable right then.
        if (res.status === 423 || res.status === 429) {
          const submitBtn = document.getElementById('lg-submit');
          const label = document.getElementById('lg-submit-label');
          submitBtn.disabled = true;
          label.textContent = res.status === 423 ? 'Account locked' : 'Try again later';
          if (data.lockedUntil) {
            const waitMs = new Date(data.lockedUntil).getTime() - Date.now();
            if (waitMs > 0 && waitMs < 30 * 60 * 1000) {
              setTimeout(() => {
                submitBtn.disabled = false;
                label.textContent = 'Sign In';
                clearError();
              }, waitMs + 500);
            }
          }
          return;
        }

        document.getElementById('lg-pass').select();
        return;
      }

      if (document.getElementById('lg-remember').checked) {
        localStorage.setItem(LAST_USER_KEY, username);
      } else {
        localStorage.removeItem(LAST_USER_KEY);
      }

      localStorage.setItem('vpr_token', data.token);
      onLoginSuccess(data.token, data.user);
    } catch (err) {
      showError('Could not reach the server. Is "npm start" running?');
      setBusy(false);
    }
  }

  function onLoginSuccess(token, user) {
    window.AUTH = { token, user };
    overlay.remove();
    console.info(`[auth] Logged in as ${user.name} (${user.role}${user.team ? ', ' + user.team : ''})`);
    document.dispatchEvent(new CustomEvent('vpr-auth-ready'));
    if (typeof window.loadDataFromAPI === 'function') window.loadDataFromAPI();
  }

  // On page load: if a token is already saved, show a lightweight "restoring
  // your session" state and verify it before trusting it — no login form
  // flash while that check is in flight.
  async function init() {
    const saved = localStorage.getItem('vpr_token');

    if (!saved) {
      mountOverlay();
      return;
    }

    const restoring = document.createElement('div');
    restoring.id = 'login-gate';
    restoring.innerHTML = `<div class="lg-restoring"><div class="lg-spinner"></div><span>Restoring your session…</span></div>`;
    document.body.appendChild(restoring);

    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: 'Bearer ' + saved },
      });
      if (!res.ok) {
        localStorage.removeItem('vpr_token');
        restoring.remove();
        mountOverlay();
        return;
      }
      const user = await res.json();
      restoring.remove();
      onLoginSuccess(saved, user);
    } catch (err) {
      // Server unreachable — fall back to the login form.
      restoring.remove();
      mountOverlay();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

// Clear the persisted and in-memory session, then return to the login gate.
window.logout = function () {
  localStorage.removeItem('vpr_token');
  window.AUTH = null;
  location.reload();
};
