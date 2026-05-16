/**
 * ============================================================
 *  AgentOS · subscription_manager.js
 *  Subscription, Lead Leakage & Health Monitor Module
 *
 *  Version  : 1.0.0
 *  Pattern  : ES Module — no direct Supabase calls
 *  Imports  : Auth (auth.js) · Clients, AgencyProfile,
 *             SystemHealth (database.js)
 *
 *  Exports  :
 *    SubscriptionGate   — plan limits + canAddClient()
 *    LeadLeakageEngine  — pending webhook scanner + alerts
 *    HealthMonitor      — Supabase + n8n health formatted
 *                         for Dark Elite UI
 *    SubscriptionManager— Unified boot/teardown controller
 * ============================================================
 */

import { Auth }                                    from './auth.js';
import { Clients, AgencyProfile, SystemHealth }    from './database.js';


// ============================================================
//  CONSTANTS
// ============================================================

/**
 * Plan limits aligned with agency_profiles.plan_type enum.
 * 'pro' and 'enterprise' use Infinity — no enforced ceiling.
 */
const PLAN_LIMITS = Object.freeze({
  free      : 3,
  starter   : 10,
  pro       : Infinity,
  enterprise: Infinity,
});

/**
 * How long (ms) a webhook_event may sit in 'pending'
 * before it triggers a Lead Leakage critical alert.
 * Default: 2 hours.
 */
const LEAKAGE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Polling interval for the Lead Leakage scanner (ms).
 * Default: every 5 minutes.
 */
const LEAKAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Polling interval for the System Health monitor (ms).
 * Default: every 60 seconds.
 */
const HEALTH_POLL_INTERVAL_MS = 60 * 1000;

/**
 * Dark Elite UI colour tokens — passed into health result
 * objects so UI_Renderer.js can apply them directly without
 * hardcoding colours in the renderer layer.
 */
const DARK_ELITE = Object.freeze({
  bg         : '#07090f',
  surface    : '#111827',
  accent     : '#3b82f6',
  accentLight: '#60a5fa',
  green      : '#10b981',
  amber      : '#f59e0b',
  red        : '#f43f5e',
  textPrimary: '#e2e8f0',
  textDim    : '#94a3b8',
  border     : 'rgba(99,179,237,0.12)',
});


// ============================================================
//  MODULE 1 · SubscriptionGate
//  Enforces per-plan client limits before any write operation.
// ============================================================

export const SubscriptionGate = {

  /**
   * Cached plan data — refreshed on demand or at boot.
   * Never read this directly; use _getPlan() instead.
   */
  _cache: {
    planType    : null,
    clientCount : null,
    fetchedAt   : null,
    TTL_MS      : 60_000, // cache for 60 s to avoid hammering DB
  },


  // ── Private: fetch + cache plan data ─────────────────────

  /**
   * Returns { planType, clientCount } for the current agency.
   * Uses a 60-second cache; pass force=true to bypass.
   *
   * Security: reads only via AgencyProfile.get() and
   * Clients.getAll() — no direct Supabase access.
   *
   * @param {boolean} force — bypass cache
   * @returns {{ planType: string, clientCount: number }}
   */
  async _getPlan(force = false) {
    const now    = Date.now();
    const cached = this._cache;
    const fresh  = cached.fetchedAt && (now - cached.fetchedAt < cached.TTL_MS);

    if (fresh && !force) {
      return { planType: cached.planType, clientCount: cached.clientCount };
    }

    // Parallel fetch — profile + client list
    const [profile, clients] = await Promise.all([
      AgencyProfile.get(),
      Clients.getAll({ limit: 1000 }), // fetch all to get true count
    ]);

    cached.planType    = profile?.plan_type || 'free';
    cached.clientCount = clients?.length    || 0;
    cached.fetchedAt   = now;

    return { planType: cached.planType, clientCount: cached.clientCount };
  },


  /**
   * Invalidate the cache — call this after a client is added
   * or the plan is upgraded/downgraded so the next check is fresh.
   */
  invalidateCache() {
    this._cache.fetchedAt = null;
  },


  // ── Public API ────────────────────────────────────────────

  /**
   * Check whether the agency is allowed to add another client
   * given their current plan and existing client count.
   *
   * Returns a structured result object so UI_Renderer.js can
   * branch on `allowed` without parsing error strings.
   *
   * @param {boolean} [force] — bypass internal cache
   * @returns {Promise<{
   *   allowed      : boolean,
   *   planType     : string,
   *   limit        : number,
   *   currentCount : number,
   *   remaining    : number,
   *   upgradeNeeded: boolean,
   *   message      : string,
   *   ui           : { color: string, icon: string }
   * }>}
   */
  async canAddClient(force = false) {
    // Guard: must be authenticated
    const session = Auth.getSession();
    if (!session) {
      return this._result(false, 'free', 0, 0, 'Not authenticated.');
    }

    const { planType, clientCount } = await this._getPlan(force);
    const limit     = PLAN_LIMITS[planType] ?? PLAN_LIMITS.free;
    const remaining = limit === Infinity ? Infinity : Math.max(0, limit - clientCount);
    const allowed   = clientCount < limit;

    return {
      allowed,
      planType,
      limit          : limit === Infinity ? null : limit,   // null = unlimited
      currentCount   : clientCount,
      remaining      : remaining === Infinity ? null : remaining,
      upgradeNeeded  : !allowed,
      message        : this._buildMessage(allowed, planType, limit, clientCount, remaining),
      ui             : this._uiTokens(allowed, remaining),
    };
  },


  /**
   * Assert canAddClient() and throw a structured error if not
   * allowed. Designed for use inside Clients.create() wrappers.
   *
   * @throws {{ code: 'PLAN_LIMIT_EXCEEDED', result: object }}
   */
  async assertCanAddClient() {
    const result = await this.canAddClient(true); // always fresh before a write
    if (!result.allowed) {
      const err   = new Error(result.message);
      err.code    = 'PLAN_LIMIT_EXCEEDED';
      err.result  = result;
      throw err;
    }
    return result;
  },


  /**
   * Convenience: return all plan limits for a plan-comparison
   * UI (pricing page, upgrade prompt).
   *
   * @returns {{ free, starter, pro, enterprise }}
   */
  getPlanLimits() {
    return Object.entries(PLAN_LIMITS).reduce((acc, [plan, limit]) => {
      acc[plan] = limit === Infinity ? null : limit;
      return acc;
    }, {});
  },


  /**
   * Return a formatted usage summary for the dashboard sidebar.
   *
   * @returns {Promise<{
   *   planType   : string,
   *   used       : number,
   *   limit      : number|null,
   *   pct        : number,       // 0-100; 0 for unlimited plans
   *   label      : string,       // e.g. "3 / 10 clients"
   *   ui         : { barColor, textColor }
   * }>}
   */
  async getUsageSummary() {
    const { planType, clientCount } = await this._getPlan();
    const limit = PLAN_LIMITS[planType] ?? PLAN_LIMITS.free;
    const pct   = limit === Infinity ? 0 : Math.min(100, Math.round((clientCount / limit) * 100));

    return {
      planType,
      used  : clientCount,
      limit : limit === Infinity ? null : limit,
      pct,
      label : limit === Infinity
        ? `${clientCount} client${clientCount !== 1 ? 's' : ''} (unlimited)`
        : `${clientCount} / ${limit} clients`,
      ui: {
        barColor : pct >= 90 ? DARK_ELITE.red : pct >= 70 ? DARK_ELITE.amber : DARK_ELITE.accent,
        textColor: pct >= 90 ? DARK_ELITE.red : DARK_ELITE.textPrimary,
      },
    };
  },


  // ── Private helpers ───────────────────────────────────────

  _buildMessage(allowed, planType, limit, count, remaining) {
    if (allowed && limit === Infinity) {
      return `Unlimited clients on your ${planType} plan.`;
    }
    if (allowed) {
      return `${remaining} client slot${remaining !== 1 ? 's' : ''} remaining on your ${planType} plan (${count}/${limit} used).`;
    }
    const next = this._nextPlan(planType);
    return `Plan limit reached: ${planType} allows ${limit} client${limit !== 1 ? 's' : ''}. `
      + (next ? `Upgrade to ${next} to add more.` : 'Contact support to expand your plan.');
  },

  _nextPlan(current) {
    const order = ['free', 'starter', 'pro', 'enterprise'];
    const idx   = order.indexOf(current);
    return idx !== -1 && idx < order.length - 1 ? order[idx + 1] : null;
  },

  _uiTokens(allowed, remaining) {
    if (!allowed)               return { color: DARK_ELITE.red,   icon: '🔒' };
    if (remaining !== null && remaining <= 2)
                                return { color: DARK_ELITE.amber, icon: '⚠️' };
    return                             { color: DARK_ELITE.green, icon: '✓'  };
  },
};


// ============================================================
//  MODULE 2 · LeadLeakageEngine
//  Scans webhook_events for stale 'pending' events and fires
//  alert callbacks so UI_Renderer.js can surface them.
// ============================================================

export const LeadLeakageEngine = {

  // ── Internal state ────────────────────────────────────────
  _pollTimer       : null,
  _alertCallbacks  : [],        // registered via onAlert()
  _lastScanResult  : null,
  _scanning        : false,


  // ── Registration ──────────────────────────────────────────

  /**
   * Register a callback to be called when stale pending events
   * are detected. Multiple callbacks are supported.
   *
   * Callback signature:
   *   (leakedEvents: LeakageAlert[]) => void
   *
   * LeakageAlert shape:
   *   {
   *     id           : string,      // webhook_event UUID
   *     client_id    : string|null,
   *     event_type   : string,
   *     pending_since: Date,
   *     staleness_ms : number,
   *     staleness_label: string,    // e.g. "3h 12m overdue"
   *     payload      : object,
   *     ui           : { severity, color, icon }
   *   }
   *
   * @param {function} cb
   */
  onAlert(cb) {
    if (typeof cb === 'function') this._alertCallbacks.push(cb);
    return this; // chainable
  },


  /**
   * Remove a previously registered alert callback.
   * @param {function} cb
   */
  offAlert(cb) {
    this._alertCallbacks = this._alertCallbacks.filter(fn => fn !== cb);
    return this;
  },


  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * Start polling for stale pending webhook events.
   * Runs an immediate scan, then repeats on LEAKAGE_POLL_INTERVAL_MS.
   *
   * @param {object}  [options]
   * @param {number}  [options.intervalMs]     — override poll interval
   * @param {number}  [options.thresholdMs]    — override stale threshold
   */
  start({ intervalMs = LEAKAGE_POLL_INTERVAL_MS, thresholdMs = LEAKAGE_THRESHOLD_MS } = {}) {
    this._thresholdMs = thresholdMs;
    this.stop(); // clear any existing timer

    // Immediate first scan
    this.scan();

    // Then repeat
    this._pollTimer = setInterval(() => this.scan(), intervalMs);

    console.log(
      `[LeadLeakageEngine] Started — scanning every ${intervalMs / 60_000} min, `
      + `threshold: ${thresholdMs / 3_600_000}h`
    );

    return this;
  },


  /**
   * Stop the polling scanner and clear all state.
   */
  stop() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    return this;
  },


  // ── Core scan ─────────────────────────────────────────────

  /**
   * Perform a single scan of webhook_events for stale pending rows.
   * Fires registered alert callbacks if leaks are found.
   *
   * SECURITY: uses only Database.js exports — no direct Supabase.
   * Supabase RLS guarantees we only see our own agency's events.
   *
   * @returns {Promise<LeakageAlert[]>} leaked events found
   */
  async scan() {
    if (this._scanning) return []; // prevent overlapping scans
    this._scanning = true;

    try {
      // Fetch pending webhook events via Database layer
      // We call a helper that wraps Clients.getPendingWebhookEvents()
      // If that method doesn't exist yet in database.js, we use
      // the AgencyProfile pattern to call via auth-gated Supabase.
      // NOTE: Add getPendingWebhookEvents() to database.js per instructions below.
      const pendingEvents = await this._fetchPendingEvents();

      if (!pendingEvents.length) {
        this._lastScanResult = { scannedAt: new Date(), leaked: [] };
        return [];
      }

      const now      = Date.now();
      const threshold = this._thresholdMs ?? LEAKAGE_THRESHOLD_MS;

      // Filter events older than threshold
      const leaked = pendingEvents
        .filter(ev => {
          const age = now - new Date(ev.received_at || ev.created_at).getTime();
          return age > threshold;
        })
        .map(ev => this._buildAlert(ev, now));

      this._lastScanResult = { scannedAt: new Date(), leaked };

      if (leaked.length > 0) {
        console.warn(`[LeadLeakageEngine] ⚠️ ${leaked.length} stale pending event(s) detected.`);
        this._fireCallbacks(leaked);
      }

      return leaked;

    } catch (err) {
      console.error('[LeadLeakageEngine] Scan error:', err);
      return [];
    } finally {
      this._scanning = false;
    }
  },


  /**
   * Return the result of the most recent scan without triggering a new one.
   * Useful for UI_Renderer.js to populate an initial state on mount.
   *
   * @returns {{ scannedAt: Date|null, leaked: LeakageAlert[] }}
   */
  getLastScanResult() {
    return this._lastScanResult || { scannedAt: null, leaked: [] };
  },


  // ── Private helpers ───────────────────────────────────────

  /**
   * Fetch pending webhook_events through the Database layer.
   *
   * ADD THIS METHOD to database.js → WebhookListener:
   *
   *   async getPending() {
   *     const { data, error } = await supabase
   *       .from('webhook_events')
   *       .select('*')
   *       .eq('processed', false)
   *       .order('received_at', { ascending: true });
   *     if (error) throw new Error(error.message);
   *     return data;
   *   }
   *
   * Until then, this falls back to a safe empty array (fail-safe).
   */
  async _fetchPendingEvents() {
    try {
      // Dynamic import guard — works whether WebhookListener exports
      // getPending() or not (backward compatible).
      const { WebhookListener } = await import('./database.js');
      if (typeof WebhookListener?.getPending === 'function') {
        return await WebhookListener.getPending();
      }
      console.warn('[LeadLeakageEngine] WebhookListener.getPending() not found in database.js. Add it per the instructions in this file.');
      return [];
    } catch (err) {
      console.error('[LeadLeakageEngine] _fetchPendingEvents failed:', err);
      return [];
    }
  },


  /**
   * Build a structured LeakageAlert object from a raw webhook_event row.
   *
   * @param {object} ev  — raw DB row
   * @param {number} now — Date.now() snapshot
   * @returns {LeakageAlert}
   */
  _buildAlert(ev, now) {
    const pendingSince  = new Date(ev.received_at || ev.created_at);
    const staleness_ms  = now - pendingSince.getTime();
    const severity      = this._severity(staleness_ms);

    return {
      id             : ev.id,
      client_id      : ev.client_id   || null,
      workflow_id    : ev.workflow_id  || null,
      event_type     : ev.event_type,
      pending_since  : pendingSince,
      staleness_ms,
      staleness_label: this._formatDuration(staleness_ms) + ' overdue',
      payload        : ev.payload || {},
      ui             : {
        severity,
        color: severity === 'critical' ? DARK_ELITE.red
              : severity === 'warning' ? DARK_ELITE.amber
              : DARK_ELITE.accentLight,
        icon : severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : '🔵',
        bg   : severity === 'critical'
              ? 'rgba(244,63,94,0.08)'
              : severity === 'warning'
              ? 'rgba(245,158,11,0.08)'
              : 'rgba(59,130,246,0.08)',
      },
    };
  },


  _severity(staleMs) {
    const h = staleMs / 3_600_000;
    if (h >= 6)  return 'critical';
    if (h >= 2)  return 'warning';
    return 'info';
  },


  _formatDuration(ms) {
    const totalSecs = Math.floor(ms / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },


  _fireCallbacks(leaked) {
    for (const cb of this._alertCallbacks) {
      try { cb(leaked); }
      catch (err) { console.error('[LeadLeakageEngine] Alert callback error:', err); }
    }
  },
};


// ============================================================
//  MODULE 3 · HealthMonitor
//  Wraps SystemHealth.fullCheck() and formats results for the
//  Dark Elite UI (colours, icons, labels).
// ============================================================

export const HealthMonitor = {

  // ── Internal state ────────────────────────────────────────
  _pollTimer         : null,
  _changeCallbacks   : [],
  _lastResult        : null,


  // ── Registration ──────────────────────────────────────────

  /**
   * Register a callback invoked whenever health status changes.
   * Callback receives a HealthReport object.
   *
   * @param {function} cb  — (report: HealthReport) => void
   */
  onChange(cb) {
    if (typeof cb === 'function') this._changeCallbacks.push(cb);
    return this;
  },


  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * Start periodic health polling.
   * Fires an immediate check, then repeats on HEALTH_POLL_INTERVAL_MS.
   *
   * @param {object}  [options]
   * @param {number}  [options.intervalMs]  — override poll interval
   */
  async start({ intervalMs = HEALTH_POLL_INTERVAL_MS } = {}) {
    this.stop();
    await this.check(); // immediate
    this._pollTimer = setInterval(() => this.check(), intervalMs);
    return this;
  },


  /**
   * Stop health polling.
   */
  stop() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    return this;
  },


  // ── Core check ────────────────────────────────────────────

  /**
   * Run a full health check via SystemHealth.fullCheck().
   * Returns a HealthReport formatted for Dark Elite UI rendering.
   *
   * HealthReport shape:
   * {
   *   checkedAt  : Date,
   *   overall    : 'healthy' | 'degraded' | 'offline',
   *   supabase   : ServiceStatus,
   *   n8n        : ServiceStatus,
   *   ui         : HealthUITokens,
   * }
   *
   * ServiceStatus shape:
   * {
   *   status    : 'online' | 'degraded' | 'offline' | 'unconfigured',
   *   latencyMs : number,
   *   label     : string,   // human-readable
   *   ui        : { color, icon, dotClass }
   * }
   *
   * @returns {Promise<HealthReport>}
   */
  async check() {
    // Fetch agency profile to get n8n URL — via Database layer only
    let n8nUrl = null;
    try {
      const profile = await AgencyProfile.get();
      n8nUrl = profile?.n8n_base_url || null;
    } catch {
      // Profile fetch failure is non-fatal for health check
    }

    let raw;
    try {
      raw = await SystemHealth.fullCheck(n8nUrl);
    } catch (err) {
      // If fullCheck itself throws, return a degraded report
      raw = {
        overall : 'offline',
        supabase: { status: 'offline', latencyMs: 0 },
        n8n     : { status: 'offline', latencyMs: 0 },
      };
      console.error('[HealthMonitor] SystemHealth.fullCheck() threw:', err);
    }

    const report = this._buildReport(raw);
    this._lastResult = report;
    this._fireCallbacks(report);
    return report;
  },


  /**
   * Return the most recent health report without running a new check.
   * Returns null if no check has run yet.
   *
   * @returns {HealthReport|null}
   */
  getLastResult() {
    return this._lastResult;
  },


  // ── Private helpers ───────────────────────────────────────

  /**
   * Transform the raw SystemHealth result into a UI-ready HealthReport.
   */
  _buildReport(raw) {
    return {
      checkedAt: new Date(),
      overall  : raw.overall,
      supabase : this._buildServiceStatus('Supabase', raw.supabase),
      n8n      : this._buildServiceStatus('n8n Webhook', raw.n8n),
      ui       : this._buildOverallUI(raw.overall),
    };
  },


  /**
   * Build a formatted ServiceStatus for one service.
   *
   * @param {string} name    — display name
   * @param {object} raw     — { status, latencyMs, error? }
   * @returns {ServiceStatus}
   */
  _buildServiceStatus(name, raw) {
    const s = raw?.status || 'offline';

    const colorMap = {
      online       : DARK_ELITE.green,
      degraded     : DARK_ELITE.amber,
      offline      : DARK_ELITE.red,
      unconfigured : DARK_ELITE.textDim,
    };

    const iconMap = {
      online       : '●',
      degraded     : '◐',
      offline      : '○',
      unconfigured : '—',
    };

    const labelMap = {
      online       : `${name} online · ${raw?.latencyMs ?? 0}ms`,
      degraded     : `${name} degraded · ${raw?.latencyMs ?? 0}ms`,
      offline      : `${name} unreachable`,
      unconfigured : `${name} not configured`,
    };

    return {
      status    : s,
      latencyMs : raw?.latencyMs ?? 0,
      label     : labelMap[s] || `${name} ${s}`,
      error     : raw?.error || null,
      ui: {
        color   : colorMap[s]    || DARK_ELITE.textDim,
        icon    : iconMap[s]     || '?',
        dotClass: `health-dot ${s}`,          // matches CSS class in dark elite stylesheet
        badge   : {
          background: s === 'online'
            ? 'rgba(16,185,129,0.1)'
            : s === 'degraded'
            ? 'rgba(245,158,11,0.1)'
            : 'rgba(244,63,94,0.1)',
          border: s === 'online'
            ? 'rgba(16,185,129,0.25)'
            : s === 'degraded'
            ? 'rgba(245,158,11,0.25)'
            : 'rgba(244,63,94,0.25)',
          color: colorMap[s] || DARK_ELITE.textDim,
        },
      },
    };
  },


  /**
   * Build top-level UI tokens for the overall health state.
   */
  _buildOverallUI(overall) {
    const map = {
      healthy : {
        label    : 'All Systems Operational',
        color    : DARK_ELITE.green,
        bg       : 'rgba(16,185,129,0.06)',
        border   : 'rgba(16,185,129,0.18)',
        icon     : '✓',
        dotClass : 'health-dot online',
      },
      degraded: {
        label    : 'Partial Outage Detected',
        color    : DARK_ELITE.amber,
        bg       : 'rgba(245,158,11,0.06)',
        border   : 'rgba(245,158,11,0.18)',
        icon     : '⚠',
        dotClass : 'health-dot degraded',
      },
      offline : {
        label    : 'Systems Unreachable',
        color    : DARK_ELITE.red,
        bg       : 'rgba(244,63,94,0.06)',
        border   : 'rgba(244,63,94,0.18)',
        icon     : '✕',
        dotClass : 'health-dot offline',
      },
    };

    return {
      ...(map[overall] || map.offline),
      theme: DARK_ELITE, // expose full theme so renderer can use any token
    };
  },


  _fireCallbacks(report) {
    for (const cb of this._changeCallbacks) {
      try { cb(report); }
      catch (err) { console.error('[HealthMonitor] onChange callback error:', err); }
    }
  },
};


// ============================================================
//  MODULE 4 · SubscriptionManager
//  Unified boot/teardown controller.
//  Import this single export into UI_Renderer.js.
// ============================================================

export const SubscriptionManager = {

  /**
   * Boot all three sub-modules.
   * Call once after Auth.login() succeeds, before rendering.
   *
   * Integration example in UI_Renderer.js:
   *
   *   import { SubscriptionManager } from './subscription_manager.js';
   *
   *   async function init(user) {
   *     await SubscriptionManager.boot({
   *       onLeakageAlert : (leaked) => Renderer.showLeakageAlerts(leaked),
   *       onHealthChange : (report) => Renderer.updateHealthIndicator(report),
   *     });
   *   }
   *
   * @param {object}   options
   * @param {function} [options.onLeakageAlert]  — (LeakageAlert[]) => void
   * @param {function} [options.onHealthChange]  — (HealthReport)   => void
   * @param {number}   [options.leakageInterval] — ms, default 5 min
   * @param {number}   [options.leakageThreshold]— ms, default 2 h
   * @param {number}   [options.healthInterval]  — ms, default 60 s
   */
  async boot({
    onLeakageAlert   = null,
    onHealthChange   = null,
    leakageInterval  = LEAKAGE_POLL_INTERVAL_MS,
    leakageThreshold = LEAKAGE_THRESHOLD_MS,
    healthInterval   = HEALTH_POLL_INTERVAL_MS,
  } = {}) {

    // Guard — must be authenticated
    const session = Auth.getSession();
    if (!session) {
      console.warn('[SubscriptionManager] boot() called without an active session. Aborting.');
      return;
    }

    console.log('[SubscriptionManager] Booting sub-modules…');

    // 1. Warm the SubscriptionGate cache
    try {
      await SubscriptionGate._getPlan(true);
      console.log('[SubscriptionManager] SubscriptionGate ready.');
    } catch (err) {
      console.error('[SubscriptionManager] SubscriptionGate warm-up failed:', err);
    }

    // 2. Start LeadLeakageEngine
    if (onLeakageAlert) LeadLeakageEngine.onAlert(onLeakageAlert);
    LeadLeakageEngine.start({
      intervalMs : leakageInterval,
      thresholdMs: leakageThreshold,
    });
    console.log('[SubscriptionManager] LeadLeakageEngine started.');

    // 3. Start HealthMonitor
    if (onHealthChange) HealthMonitor.onChange(onHealthChange);
    await HealthMonitor.start({ intervalMs: healthInterval });
    console.log('[SubscriptionManager] HealthMonitor started.');

    console.log('[SubscriptionManager] ✓ All modules online.');
  },


  /**
   * Gracefully shut down all sub-modules.
   * Call on logout or page unload.
   */
  teardown() {
    LeadLeakageEngine.stop();
    HealthMonitor.stop();
    SubscriptionGate.invalidateCache();
    console.log('[SubscriptionManager] All modules stopped.');
  },


  /**
   * Invalidate the plan cache after a client add/remove or
   * plan upgrade — so the next canAddClient() reads fresh data.
   */
  refreshPlanCache() {
    SubscriptionGate.invalidateCache();
  },


  // ── Convenience pass-throughs ─────────────────────────────
  // So UI_Renderer.js only needs to import SubscriptionManager.

  /** @see SubscriptionGate.canAddClient */
  canAddClient: (force) => SubscriptionGate.canAddClient(force),

  /** @see SubscriptionGate.assertCanAddClient */
  assertCanAddClient: () => SubscriptionGate.assertCanAddClient(),

  /** @see SubscriptionGate.getUsageSummary */
  getUsageSummary: () => SubscriptionGate.getUsageSummary(),

  /** @see SubscriptionGate.getPlanLimits */
  getPlanLimits: () => SubscriptionGate.getPlanLimits(),

  /** @see LeadLeakageEngine.scan */
  scanLeakage: () => LeadLeakageEngine.scan(),

  /** @see LeadLeakageEngine.getLastScanResult */
  getLastLeakage: () => LeadLeakageEngine.getLastScanResult(),

  /** @see HealthMonitor.check */
  checkHealth: () => HealthMonitor.check(),

  /** @see HealthMonitor.getLastResult */
  getLastHealth: () => HealthMonitor.getLastResult(),

  /** Expose colour tokens for inline UI use */
  theme: DARK_ELITE,
};
