// Admin-only successful-login activity. This is an audit list, not an online-presence indicator.
(function () {
  async function showLoginActivity() {
    const res = await window.apiFetch('/api/evaluators/login-activity');
    const rows = await res.json().catch(() => []);
    if (!res.ok) { alert('Could not load login activity.'); return; }
    const fmt = value => value ? new Date(value).toLocaleString('en-IN') : '—';
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="background:#fff;width:min(760px,100%);max-height:80vh;overflow:auto;border-radius:8px;padding:20px;font-family:system-ui,sans-serif;"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;"><h3 style="margin:0;">Login Activity</h3><button id="close-login-activity">Close</button></div><p style="color:#667085;font-size:12px;">Successful logins recorded since this feature was enabled.</p><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Name</th><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Role</th><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Team</th><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Last login</th></tr></thead><tbody>${rows.map(r => `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${hesc(r.name)}</td><td style="padding:8px;border-bottom:1px solid #eee;">${hesc(r.role)}</td><td style="padding:8px;border-bottom:1px solid #eee;">${hesc(r.team || '—')}</td><td style="padding:8px;border-bottom:1px solid #eee;">${hesc(fmt(r.last_login_at))}</td></tr>`).join('') || '<tr><td colspan="4" style="padding:12px;">No successful logins recorded yet.</td></tr>'}</tbody></table></div>`;
    document.body.appendChild(modal);
    modal.querySelector('#close-login-activity').onclick = () => modal.remove();
  }
  document.addEventListener('vpr-auth-ready', () => {
    if (!window.AUTH || window.AUTH.user.role !== 'admin' || document.getElementById('login-activity-button')) return;
    const button = document.createElement('button');
    button.id = 'login-activity-button'; button.textContent = 'Login Activity';
    button.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;padding:10px 16px;background:#1f5f94;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;';
    button.onclick = showLoginActivity; document.body.appendChild(button);
  });
})();
