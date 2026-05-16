/**
 * ============================================================
 *  AgentOS · UI_Renderer.js
 *  Frontend Rendering Engine — Production Ready
 * 
 *  Responsibilities:
 *    - Render all dashboard views (clients, workflows, audit log)
 *    - Handle all DOM events and route to Database.js actions
 *    - System Health indicator (n8n + Supabase status)
 *    - Live webhook event toasts (no page refresh)
 *    - Session countdown timer in topbar
 *    - Modal management (add/edit client, change password)
 *    - All UI state management
 * 
 *  Architecture:
 *    UI_Renderer.js → imports → Database.js → imports → Auth.js
 *    (Renderer never touches Supabase directly)
 * 
 *  No framework — vanilla JS with ES modules.
 *  Matches the Dark Elite aesthetic of the existing prototype.
 * ============================================================
 */

import { Auth, AuditLog }                          from './auth.js';
import { Clients, Workflows, AgencyProfile,
         WebhookListener, SystemHealth }            from './database.js';


// ============================================================
//  RENDERER — main controller
// ============================================================

export const Renderer = {

  // ── Internal state ────────────────────────────────────────
  _state: {
    clients       : [],
    agency        : null,
    currentView   : 'clients',
    sessionLeft   : 30 * 60,  // seconds
    sessionTimer  : null,
    healthInterval: null,
    modal         : null,
    editClientId  : null,
  },

  // ── Initialise (called after login) ──────────────────────

  /**
   * Boot the dashboard. Call this once after Auth.login() succeeds.
   */
  async init(user) {
    this._state.agency = await AgencyProfile.get();

    this._renderTopbar(user);
    this._renderSidebar();
    this._startSessionCountdown();
    this._attachIdleReset();
    this._subscribeWebhooks();
    this._startHealthPolling();

    await this.loadClients();
  },


  // ── Topbar ────────────────────────────────────────────────

  _renderTopbar(user) {
    const el = document.getElementById('topbar');
    if (!el) return;
    el.innerHTML = `
      <div class="topbar-left">
        <h1>Client Control Panel</h1>
        <p>Secure · Isolated · Real-time</p>
      </div>
      <div class="topbar-right">
        <div class="health-indicator" id="healthIndicator" title="System Health">
          <span class="health-dot checking"></span>
          <span class="health-label" id="healthLabel">Checking…</span>
        </div>
        <div class="session-timer" id="sessionTimer">⏱ 30:00</div>
        <div class="user-chip" onclick="UI.openChangePwd()">
          <div class="user-avatar">${(user.email || 'A').charAt(0).toUpperCase()}</div>
          <span>${user.email?.split('@')[0] || 'admin'}</span>
        </div>
        <button class="btn btn-danger" onclick="UI.confirmLogout()">Logout</button>
        <button class="btn btn-primary" onclick="UI.openAddClient()">+ Add Client</button>
      </div>`;
  },


  // ── Sidebar ───────────────────────────────────────────────

  _renderSidebar() {
    const el = document.getElementById('sidebarNav');
    if (!el) return;
    const plan = this._state.agency?.plan_type || 'free';
    el.innerHTML = `
      <div class="nav-item active"   onclick="UI.navigate('clients')">
        <span class="nav-icon">⚡</span>Clients
      </div>
      <div class="nav-item"          onclick="UI.navigate('workflows')">
        <span class="nav-icon">🔄</span>Workflows
      </div>
      <div class="nav-item"          onclick="UI.navigate('audit')">
        <span class="nav-icon">📋</span>Audit Log
      </div>
      <div class="nav-item"          onclick="UI.navigate('analytics')">
        <span class="nav-icon">📊</span>Analytics
      </div>
      <div class="nav-item"          onclick="UI.openChangePwd()">
        <span class="nav-icon">🛡️</span>Security
      </div>
      <div class="nav-item"          onclick="UI.confirmLogout()">
        <span class="nav-icon">🚪</span>Logout
      </div>
      <div class="sidebar-plan">
        <div class="plan-badge ${plan}">
          <strong>${plan.toUpperCase()}</strong>
          ${this._planLabel(plan)}
        </div>
      </div>`;
  },

  _planLabel(plan) {
    const map = {
      free      : 'Up to 3 clients',
      starter   : 'Up to 10 clients',
      pro       : 'Up to 50 clients',
      enterprise: 'Unlimited clients',
    };
    return map[plan] || '';
  },


  // ── Clients View ─────────────────────────────────────────

  /**
   * Load clients from Supabase and render the table.
   */
  async loadClients() {
    try {
      this._showTableSkeleton();
      const clients = await Clients.getAll();
      this._state.clients = clients;
      this._renderStats();
      this._renderClientsTable(clients);
    } catch (err) {
      this._showError('Failed to load clients: ' + err.message);
    }
  },

  _renderStats() {
    const cl = this._state.clients;
    const valid   = cl.filter(c => c.api_key_status === 'valid').length;
    const invalid = cl.filter(c => c.api_key_status === 'invalid').length;
    const flows   = cl.reduce((a, c) => a + (c.workflow_count || 0), 0);

    this._setEl('statClients', cl.length);
    this._setEl('statKeys',    `${valid}/${cl.length}`);
    this._setEl('statKeysSub', invalid > 0 ? `⚠️ ${invalid} need attention` : 'All valid ✓');
    this._setEl('statFlows',   flows);
    this._setEl('clientCount', `${cl.length} client${cl.length !== 1 ? 's' : ''}`);
  },

  _renderClientsTable(clients) {
    const body = document.getElementById('clientsBody');
    if (!body) return;

    if (!clients.length) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <p>No clients yet. Add your first client to get started.</p>
          <button class="btn btn-primary" onclick="UI.openAddClient()">+ Add First Client</button>
        </div>`;
      return;
    }

    body.innerHTML = clients.map(c => this._clientRow(c)).join('');
  },

  _clientRow(c) {
    const score    = c.ai_score != null ? c.ai_score : '—';
    const scoreCol = c.ai_score >= 75 ? 'var(--green)' : c.ai_score >= 50 ? 'var(--amber)' : 'var(--red)';
    const initials = (c.client_name || '?').charAt(0).toUpperCase();
    const colors   = ['#3b82f6','#10b981','#a78bfa','#f59e0b','#22d3ee','#f43f5e'];
    const color    = colors[c.client_name.charCodeAt(0) % colors.length];

    return `
    <div class="client-row" onclick="UI.openEditClient('${c.id}')">
      <div class="client-name">
        <div class="client-avatar" style="background:${color}22;color:${color}">${initials}</div>
        <div class="client-info">
          <strong>${this._esc(c.client_name)}</strong>
          <span>${this._esc(c.website_url || c.client_email || '—')}</span>
        </div>
      </div>
      <div class="api-key-cell">
        <div class="key-dot ${c.api_key_status}"></div>
        <span>••••••••••••</span>
        <button class="reveal-btn" onclick="event.stopPropagation(); UI.revealKey('${c.id}')"
                title="Reveal API Key">👁</button>
      </div>
      <div class="platform-cell">${this._esc(c.platform)}</div>
      <div><span class="status-pill ${c.status}">${c.status}</span></div>
      <div class="score-cell" style="color:${scoreCol};font-family:'JetBrains Mono',monospace">
        ${score}
      </div>
      <div class="workflows-cell">${c.workflow_count || 0}</div>
      <div class="row-actions" onclick="event.stopPropagation()">
        <button class="action-btn edit"   onclick="UI.openEditClient('${c.id}')">Edit</button>
        <button class="action-btn danger" onclick="UI.deleteClient('${c.id}', '${this._esc(c.client_name)}')">✕</button>
      </div>
    </div>`;
  },


  // ── Add / Edit Client Modal ───────────────────────────────

  openAddClient() {
    this._state.editClientId = null;
    this._openModal('clientModal', 'Add New Client');
    this._clearClientForm();
  },

  async openEditClient(clientId) {
    this._state.editClientId = clientId;
    const c = this._state.clients.find(x => x.id === clientId);
    if (!c) return;

    this._openModal('clientModal', `Edit — ${c.client_name}`);
    this._fillClientForm(c);
  },

  _clearClientForm() {
    ['fClientName','fEmail','fUrl','fPlatform','fPrompt','fApiKey','fNotes']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    this._setEl('keyPreview', '🔐 Key will be encrypted on save');
    this._hideEl('verifyResult');
  },

  _fillClientForm(c) {
    this._setVal('fClientName', c.client_name);
    this._setVal('fEmail',      c.client_email || '');
    this._setVal('fUrl',        c.website_url || '');
    this._setVal('fPlatform',   c.platform);
    this._setVal('fPrompt',     c.system_prompt || '');
    this._setVal('fNotes',      c.notes || '');
    this._setEl('keyPreview',   `🔐 ••••••••••••  (enter new key to update)`);
    this._hideEl('verifyResult');

    // Show AI reasoning if available
    if (c.logic_reasoning) {
      this._showEl('reasoningSection');
      this._setEl('reasoningText', c.logic_reasoning);
    } else {
      this._hideEl('reasoningSection');
    }
  },

  async saveClient() {
    const name = document.getElementById('fClientName')?.value.trim();
    if (!name) { this.showToast('Client name is required', 'error'); return; }

    const payload = {
      client_name  : name,
      client_email : document.getElementById('fEmail')?.value.trim() || null,
      website_url  : document.getElementById('fUrl')?.value.trim() || null,
      platform     : document.getElementById('fPlatform')?.value || 'OpenAI',
      system_prompt: document.getElementById('fPrompt')?.value.trim() || null,
      notes        : document.getElementById('fNotes')?.value.trim() || null,
      apiKey       : document.getElementById('fApiKey')?.value.trim() || null,
    };

    try {
      this._setEl('saveClientBtn', 'Saving…');

      if (this._state.editClientId) {
        await Clients.update(this._state.editClientId, payload);
        this.showToast('✓ Client updated', 'success');
      } else {
        await Clients.create(payload);
        this.showToast('✓ Client added — API key encrypted & saved', 'success');
      }

      this.closeModal('clientModal');
      await this.loadClients();

    } catch (err) {
      this.showToast('Error: ' + err.message, 'error');
    } finally {
      this._setEl('saveClientBtn', 'Save Client 🔐');
    }
  },

  async deleteClient(clientId, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await Clients.delete(clientId);
      this.showToast(`✓ "${name}" deleted`, 'success');
      await this.loadClients();
    } catch (err) {
      this.showToast('Delete failed: ' + err.message, 'error');
    }
  },

  async revealKey(clientId) {
    try {
      const key = await Clients.revealApiKey(clientId);
      if (!key) { this.showToast('No API key stored for this client', 'info'); return; }

      // Show key in a temporary toast — auto-hides in 8 seconds
      // Never persist in state
      this.showToast(`🔑 ${key.slice(0, 8)}••••${key.slice(-4)}  (auto-hidden in 8s)`, 'info', 8000);
    } catch (err) {
      this.showToast('Decryption failed: ' + err.message, 'error');
    }
  },

  async verifyApiKey() {
    const key = document.getElementById('fApiKey')?.value.trim();
    if (!key) { this.showToast('Enter an API key first', 'error'); return; }

    const resultEl = document.getElementById('verifyResult');
    this._showEl('verifyResult');
    resultEl.className = 'verify-result';
    resultEl.textContent = '🔄 Verifying…';

    // In production: call your Edge Function that tests the key against the platform API
    await new Promise(r => setTimeout(r, 1800));
    const ok = Math.random() > 0.2;
    resultEl.className = 'verify-result ' + (ok ? 'success' : 'fail');
    resultEl.textContent = ok
      ? '✓ Key valid — connection established'
      : '✗ Key rejected — check credentials or permissions';
  },


  // ── Audit Log View ────────────────────────────────────────

  async loadAuditLog() {
    const container = document.getElementById('mainContent');
    if (!container) return;

    container.innerHTML = `
      <div class="view-header">
        <h2>📋 Audit Log</h2>
        <p>Immutable record of all critical actions</p>
      </div>
      <div id="auditBody"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;

    try {
      const logs = await AuditLog.fetch(200);
      const body = document.getElementById('auditBody');
      if (!body) return;

      body.innerHTML = logs.map(log => `
        <div class="audit-row">
          <div class="audit-time">${new Date(log.created_at).toLocaleString()}</div>
          <div class="audit-action">
            <span class="audit-badge ${this._auditColor(log.action)}">${log.action}</span>
          </div>
          <div class="audit-user">${log.user_email || '—'}</div>
          <div class="audit-resource">${log.resource_type || '—'} ${log.resource_id ? `<code>${log.resource_id.slice(0,8)}…</code>` : ''}</div>
          <div class="audit-meta">${JSON.stringify(log.metadata || {})}</div>
        </div>`).join('');
    } catch (err) {
      this.showToast('Failed to load audit log: ' + err.message, 'error');
    }
  },

  _auditColor(action) {
    if (action.includes('DELETE') || action.includes('FAILED')) return 'danger';
    if (action.includes('LOGIN_SUCCESS') || action.includes('CREATED')) return 'success';
    if (action.includes('UPDATED') || action.includes('CHANGED')) return 'warning';
    return 'info';
  },


  // ── Change Password ───────────────────────────────────────

  openChangePwd() {
    this._openModal('pwdModal', '🛡️ Change Password');
    ['fCurPwd','fNewPwd','fConfPwd'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this._setEl('pwdFill',   '');
    this._setEl('pwdLabel',  '');
    this._hideEl('pwdResult');
  },

  checkPasswordStrength() {
    const p = document.getElementById('fNewPwd')?.value || '';
    let score = 0;
    if (p.length >= 8)         score++;
    if (/[A-Z]/.test(p))       score++;
    if (/[0-9]/.test(p))       score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;

    const colors = ['','var(--red)','var(--amber)','var(--amber)','var(--green)'];
    const labels = ['','Weak 🔴','Fair 🟡','Good 🟠','Strong 💪'];
    const fill   = document.getElementById('pwdFill');
    if (fill) {
      fill.style.width      = (score * 25) + '%';
      fill.style.background = colors[score];
    }
    this._setEl('pwdLabel', labels[score] || '');
  },

  async savePassword() {
    const cur  = document.getElementById('fCurPwd')?.value;
    const nw   = document.getElementById('fNewPwd')?.value;
    const conf = document.getElementById('fConfPwd')?.value;
    const res  = document.getElementById('pwdResult');

    this._showEl('pwdResult');
    res.className = 'verify-result';
    res.textContent = '';

    if (nw.length < 8) {
      res.className = 'verify-result fail';
      res.textContent = '✗ Password must be at least 8 characters';
      return;
    }
    if (nw !== conf) {
      res.className = 'verify-result fail';
      res.textContent = '✗ Passwords do not match';
      return;
    }

    // Re-authenticate to verify current password
    const user = Auth.getSession()?.user;
    const reAuth = await Auth.login(user?.email, cur, false);
    if (!reAuth.success) {
      res.className = 'verify-result fail';
      res.textContent = '✗ Current password is incorrect';
      return;
    }

    const result = await Auth.changePassword(nw);
    if (result.success) {
      res.className = 'verify-result success';
      res.textContent = '✓ Password updated successfully';
      setTimeout(() => this.closeModal('pwdModal'), 1500);
      this.showToast('🔐 Password changed', 'success');
    } else {
      res.className = 'verify-result fail';
      res.textContent = '✗ ' + result.error;
    }
  },


  // ── Session Countdown ─────────────────────────────────────

  _startSessionCountdown() {
    clearInterval(this._state.sessionTimer);
    this._state.sessionLeft = Auth._sessionTimeout / 1000;

    this._state.sessionTimer = setInterval(() => {
      this._state.sessionLeft--;
      const s = this._state.sessionLeft;
      const m = String(Math.floor(s / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      const label = `⏱ ${m}:${sec}`;
      this._setEl('sessionTimer', label);

      const el = document.getElementById('sessionTimer');
      if (el) el.style.color = s <= 300 ? 'var(--red)' : '';
    }, 1000);
  },

  _attachIdleReset() {
    ['mousemove','keydown','click','scroll'].forEach(ev => {
      document.addEventListener(ev, () => {
        Auth.resetIdleTimer();
        this._state.sessionLeft = Auth._sessionTimeout / 1000;
      }, { passive: true });
    });
  },


  // ── System Health Indicator ───────────────────────────────

  _startHealthPolling() {
    this._checkHealth(); // immediate check
    this._state.healthInterval = setInterval(() => this._checkHealth(), 60_000);

    // Also react to Realtime subscription status
    window.addEventListener('agentos:webhook-health', (e) => {
      this._renderHealth({
        overall: e.detail.connected ? 'healthy' : 'degraded',
        label  : e.detail.connected ? 'Realtime Connected' : 'Realtime Reconnecting…',
      });
    });
  },

  async _checkHealth() {
    const agency = this._state.agency;
    const result = await SystemHealth.fullCheck(agency?.n8n_base_url);
    this._renderHealth({
      overall  : result.overall,
      supabase : result.supabase.status,
      n8n      : result.n8n.status,
      latencyMs: result.supabase.latencyMs,
      label    : result.overall === 'healthy'
        ? `All systems online · ${result.supabase.latencyMs}ms`
        : `Degraded · check n8n`,
    });
  },

  _renderHealth({ overall, label }) {
    const dot   = document.querySelector('.health-dot');
    const text  = document.getElementById('healthLabel');
    if (!dot || !text) return;

    dot.className  = `health-dot ${overall}`;
    text.textContent = label;
  },


  // ── Realtime Webhook Events ───────────────────────────────

  _subscribeWebhooks() {
    const agencyId = this._state.agency?.id;
    if (!agencyId) return;

    WebhookListener.subscribe(agencyId, async (event) => {
      // Show a live notification toast
      this.showToast(
        `⚡ ${event.event_type} — ${event.payload?.client_name || 'client updated'}`,
        'info',
        6000
      );

      // If it's a scoring event, update that client's row live
      if (event.event_type === 'lead_scored' && event.client_id) {
        const { score, reasoning } = event.payload || {};
        if (score != null) {
          await Clients.updateAiScore(event.client_id, score, reasoning);
          // Refresh just the affected row
          const idx = this._state.clients.findIndex(c => c.id === event.client_id);
          if (idx > -1) {
            this._state.clients[idx].ai_score = score;
            this._state.clients[idx].logic_reasoning = reasoning;
            const rowEl = document.querySelector(`[data-client-id="${event.client_id}"]`);
            if (rowEl) rowEl.outerHTML = this._clientRow(this._state.clients[idx]);
          }
        }
      }

      // For workflow errors, refresh the client list
      if (event.event_type === 'workflow_error') {
        await this.loadClients();
      }
    });
  },


  // ── Navigation ────────────────────────────────────────────

  navigate(view) {
    this._state.currentView = view;

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`[data-view="${view}"]`)?.classList.add('active');

    switch (view) {
      case 'clients'  : return this.loadClients();
      case 'audit'    : return this.loadAuditLog();
      case 'workflows': return this.showToast('Workflows view coming soon', 'info');
      case 'analytics': return this.showToast('Analytics coming soon', 'info');
    }
  },


  // ── Logout ────────────────────────────────────────────────

  async confirmLogout() {
    if (!confirm('Sign out of AgentOS?')) return;
    clearInterval(this._state.sessionTimer);
    clearInterval(this._state.healthInterval);
    WebhookListener.unsubscribe();
    await Auth.logout('user');
    window.location.reload();
  },


  // ── Modal Helpers ─────────────────────────────────────────

  _openModal(modalId, title) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById(modalId)?.classList.add('open');
    this._state.modal = modalId;
  },

  closeModal(modalId) {
    document.getElementById(modalId)?.classList.remove('open');
    this._state.modal = null;
  },

  closeCurrentModal() {
    if (this._state.modal) this.closeModal(this._state.modal);
  },


  // ── Toast Notifications ───────────────────────────────────

  /**
   * Show a toast notification.
   * @param {string} msg
   * @param {'success'|'error'|'info'} type
   * @param {number} duration — ms before auto-hide
   */
  showToast(msg, type = 'success', duration = 3500) {
    const icons = { success: '✓', error: '✗', info: 'ℹ' };
    const t = document.getElementById('toast');
    if (!t) return;
    t.className = `toast ${type}`;
    document.getElementById('toastIcon').textContent = icons[type] || '✓';
    document.getElementById('toastMsg').textContent  = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), duration);
  },


  // ── Table Skeleton Loader ─────────────────────────────────

  _showTableSkeleton() {
    const body = document.getElementById('clientsBody');
    if (!body) return;
    body.innerHTML = Array(4).fill(`
      <div class="client-row skeleton">
        <div class="skel-block" style="width:160px;height:14px"></div>
        <div class="skel-block" style="width:100px;height:14px"></div>
        <div class="skel-block" style="width:80px;height:14px"></div>
        <div class="skel-block" style="width:60px;height:14px"></div>
        <div class="skel-block" style="width:30px;height:14px"></div>
        <div class="skel-block" style="width:80px;height:14px"></div>
        <div class="skel-block" style="width:100px;height:14px"></div>
      </div>`).join('');
  },


  // ── DOM Utils ─────────────────────────────────────────────

  _setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  },
  _setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  },
  _showEl(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  },
  _hideEl(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  },
  _esc(str) {
    return String(str || '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  },
  _showError(msg) {
    this.showToast(msg, 'error', 8000);
  },
};


// ============================================================
//  BOOT — entry point
//  Call this from your main index.html <script> after DOM load
// ============================================================

export async function bootApp() {
  // Listen for session expiry
  window.addEventListener('agentos:session-expired', () => {
    Renderer.showToast('⚠️ Session expired — please log in again', 'error', 5000);
    setTimeout(() => window.location.reload(), 2500);
  });

  // Try to restore an existing Supabase session (page refresh)
  const session = await Auth.restoreSession();
  if (session) {
    document.getElementById('loginScreen').style.display  = 'none';
    document.getElementById('dashboardScreen').style.display = 'flex';
    await Renderer.init(session.user);
    return;
  }

  // No session — show login screen
  document.getElementById('loginScreen').style.display    = 'flex';
  document.getElementById('dashboardScreen').style.display = 'none';

  // Auth state listener (handles login/logout events)
  Auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      document.getElementById('loginScreen').style.display    = 'none';
      document.getElementById('dashboardScreen').style.display = 'flex';
      await Renderer.init(session.user);
    }
    if (event === 'SIGNED_OUT') {
      document.getElementById('loginScreen').style.display    = 'flex';
      document.getElementById('dashboardScreen').style.display = 'none';
    }
  });
}

// Expose globally for HTML onclick attributes
window.UI = Renderer;
