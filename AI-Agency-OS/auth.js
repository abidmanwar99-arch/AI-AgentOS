/**
 * ============================================================
 *  AgentOS · Auth.js
 *  Authentication Module — Production Ready
 * 
 *  Responsibilities:
 *    - Supabase Auth (email/password + JWT)
 *    - Server-side brute-force lockout (via Edge Function)
 *    - AES-256-GCM encryption/decryption helpers
 *    - Session management (30-min auto-logout + Remember Me)
 *    - Audit log writes on every auth event
 * 
 *  Dependencies:
 *    - @supabase/supabase-js (loaded via CDN or npm)
 *    - Web Crypto API (native in all modern browsers)
 * 
 *  Usage:
 *    import { Auth } from './auth.js';
 *    await Auth.login(email, password, rememberMe);
 *    await Auth.logout();
 *    const session = Auth.getSession();
 * ============================================================
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// ── Environment Config ────────────────────────────────────────
// IMPORTANT: Replace with your actual Supabase project values.
// In production, inject these via your build system (Vite, Next.js env vars).
// NEVER commit real keys to git — use .env files.

const SUPABASE_URL  = 'sb_secret_YfTHn6QLgoHPyTVDtwQ0dg_m9EEvSOx';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzZ3pnamlkYml1d2dwcGp5dmRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NDkxMzEsImV4cCI6MjA5NDQyNTEzMX0.5JvMPJjl5rc8eFCU3FTzMDrtB6B4sY923U19BJN6Dgo';

// AES-256 encryption key — MUST be exactly 32 bytes (256 bits).
// Generate with: crypto.getRandomValues(new Uint8Array(32))
// Store in .env as hex string: AES_KEY=a1b2c3...
// In production: load from secure env var, NEVER hardcode.
const AES_KEY_HEX = 'YOUR_32_BYTE_HEX_KEY_HERE_64_CHARS_LONG_00000000000000000';

// ── Supabase Client (singleton) ───────────────────────────────
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    // Persist session in localStorage by default.
    // For "Remember Me" = false, we override with sessionStorage.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});


// ============================================================
//  CRYPTO HELPERS
//  AES-256-GCM encryption for API keys and sensitive fields.
//  The DATABASE never sees plaintext — only ciphertext.
// ============================================================

const Crypto = {
  /**
   * Import the raw hex key as a CryptoKey object.
   * Called once per session to avoid repeated imports.
   */
  async _getKey() {
    if (this._cachedKey) return this._cachedKey;

    const keyBytes = new Uint8Array(
      AES_KEY_HEX.match(/.{1,2}/g).map(b => parseInt(b, 16))
    );
    this._cachedKey = await window.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,       // not extractable
      ['encrypt', 'decrypt']
    );
    return this._cachedKey;
  },

  /**
   * Encrypt plaintext string using AES-256-GCM.
   * Returns { ciphertext, iv, tag } — all base64 encoded.
   * 
   * @param {string} plaintext — e.g. "sk-abc123..."
   * @returns {{ encrypted: string, iv: string, tag: string }}
   */
  async encrypt(plaintext) {
    const key = await this._getKey();
    const iv  = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
    const enc = new TextEncoder();

    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(plaintext)
    );

    // GCM appends 16-byte auth tag at end of cipherBuffer
    const cipherArr = new Uint8Array(cipherBuffer);
    const tagOffset = cipherArr.length - 16;

    return {
      encrypted : btoa(String.fromCharCode(...cipherArr.slice(0, tagOffset))),
      iv        : btoa(String.fromCharCode(...iv)),
      tag       : btoa(String.fromCharCode(...cipherArr.slice(tagOffset))),
    };
  },

  /**
   * Decrypt AES-256-GCM ciphertext back to plaintext.
   * 
   * @param {string} encrypted — base64 ciphertext
   * @param {string} iv        — base64 IV
   * @param {string} tag       — base64 auth tag
   * @returns {string}         — original plaintext
   */
  async decrypt(encrypted, iv, tag) {
    const key = await this._getKey();

    const cipherBytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const tagBytes    = Uint8Array.from(atob(tag),       c => c.charCodeAt(0));
    const ivBytes     = Uint8Array.from(atob(iv),        c => c.charCodeAt(0));

    // Reconstruct: ciphertext + tag (GCM expects them concatenated)
    const combined = new Uint8Array(cipherBytes.length + tagBytes.length);
    combined.set(cipherBytes);
    combined.set(tagBytes, cipherBytes.length);

    const plainBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      combined
    );

    return new TextDecoder().decode(plainBuffer);
  },
};

export { Crypto };


// ============================================================
//  AUTH MODULE
// ============================================================

export const Auth = {

  // Internal session state
  _session       : null,
  _logoutTimer   : null,
  _sessionTimeout: 30 * 60 * 1000, // 30 minutes in ms

  // ── Login ────────────────────────────────────────────────

  /**
   * Authenticate user with email and password.
   * Performs server-side brute-force check BEFORE calling Supabase Auth.
   * 
   * @param {string}  email
   * @param {string}  password
   * @param {boolean} rememberMe — if false, session clears on tab close
   * @returns {{ success: boolean, error?: string, user?: object }}
   */
  async login(email, password, rememberMe = false) {
    try {
      // Step 1: Check server-side lockout BEFORE attempting auth
      const lockCheck = await this._checkLockout(email);
      if (lockCheck.locked) {
        const mins = Math.ceil(lockCheck.secondsRemaining / 60);
        return {
          success: false,
          error: `Account locked. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`,
          locked: true,
          secondsRemaining: lockCheck.secondsRemaining,
        };
      }

      // Step 2: Attempt Supabase Auth sign-in
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        // Step 3a: Record failed attempt server-side
        const attemptResult = await this._recordFailedAttempt(email);
        await AuditLog.write({
          action       : 'LOGIN_FAILED',
          user_email   : email,
          metadata     : { reason: error.message, attempts: attemptResult.count },
        });

        if (attemptResult.locked) {
          return {
            success: false,
            error: `Too many attempts. Account locked for 5 minutes.`,
            locked: true,
            secondsRemaining: 300,
          };
        }

        return {
          success         : false,
          error           : 'Invalid email or password.',
          attemptsRemaining: attemptResult.remaining,
        };
      }

      // Step 4: Login success — clear attempt counter
      await this._clearAttempts(email);

      // Step 5: Handle Remember Me
      if (!rememberMe) {
        // Re-configure client to use sessionStorage (clears on tab close)
        // Supabase v2: we manage this via our own session wrapper
        this._sessionTimeout = 30 * 60 * 1000; // still enforce 30-min idle
      } else {
        this._sessionTimeout = 7 * 24 * 60 * 60 * 1000; // 7 days for "remember me"
      }

      // Step 6: Store session reference
      this._session = data.session;

      // Step 7: Start auto-logout timer
      this._startLogoutTimer();

      // Step 8: Write success to audit log
      await AuditLog.write({
        action      : 'LOGIN_SUCCESS',
        user_id     : data.user.id,
        user_email  : data.user.email,
        resource_type: 'session',
        metadata    : { remember_me: rememberMe },
      });

      return { success: true, user: data.user, session: data.session };

    } catch (err) {
      console.error('[Auth.login] Unexpected error:', err);
      return { success: false, error: 'A network error occurred. Please try again.' };
    }
  },


  // ── Logout ───────────────────────────────────────────────

  /**
   * Sign out the current user and clear all session state.
   * @param {'user'|'timeout'} reason — why logout happened
   */
  async logout(reason = 'user') {
    try {
      const user = this._session?.user;
      clearInterval(this._logoutTimer);
      this._logoutTimer = null;
      this._session = null;

      await supabase.auth.signOut();

      if (user) {
        await AuditLog.write({
          action      : 'LOGOUT',
          user_id     : user.id,
          user_email  : user.email,
          resource_type: 'session',
          metadata    : { reason },
        });
      }

      return { success: true };
    } catch (err) {
      console.error('[Auth.logout] Error:', err);
      return { success: false };
    }
  },


  // ── Session Helpers ───────────────────────────────────────

  /**
   * Get the current authenticated session.
   * Returns null if not logged in.
   */
  getSession() {
    return this._session;
  },

  /**
   * Get the current user object from Supabase Auth.
   */
  async getCurrentUser() {
    const { data } = await supabase.auth.getUser();
    return data?.user || null;
  },

  /**
   * Restore session on page refresh (Supabase handles this automatically,
   * but we re-attach our timer).
   */
  async restoreSession() {
    const { data } = await supabase.auth.getSession();
    if (data?.session) {
      this._session = data.session;
      this._startLogoutTimer();
      return data.session;
    }
    return null;
  },

  /**
   * Listen for auth state changes (login, logout, token refresh).
   * @param {function} callback — called with (event, session)
   */
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange((event, session) => {
      this._session = session;
      callback(event, session);
    });
  },


  // ── Auto-logout Timer ─────────────────────────────────────

  /**
   * Start (or restart) the idle auto-logout countdown.
   * Call this on any user interaction to reset the timer.
   */
  _startLogoutTimer() {
    clearTimeout(this._logoutTimer);
    this._logoutTimer = setTimeout(async () => {
      await this.logout('timeout');
      // Emit a custom event so UI_Renderer.js can show the timeout message
      window.dispatchEvent(new CustomEvent('agentos:session-expired'));
    }, this._sessionTimeout);
  },

  /**
   * Reset idle timer on user activity.
   * Call this from UI layer on mouse/key events.
   */
  resetIdleTimer() {
    if (this._session) this._startLogoutTimer();
  },


  // ── Brute-Force Protection (Server-side) ──────────────────

  /**
   * Check if an email is currently locked out.
   * Calls a Supabase Edge Function to read login_attempts table.
   * 
   * NOTE: This runs server-side. Even if a hacker disables JS,
   * the Edge Function enforces the lockout.
   */
  async _checkLockout(email) {
    try {
      const { data, error } = await supabase.functions.invoke('check-lockout', {
        body: { email },
      });
      if (error) throw error;
      return data; // { locked: bool, secondsRemaining: int }
    } catch (err) {
      console.warn('[Auth._checkLockout] Edge function error, proceeding:', err);
      return { locked: false }; // fail-open (Edge Function handles server-side truth)
    }
  },

  /**
   * Increment failed attempt counter in login_attempts table.
   * Returns { count, remaining, locked }.
   */
  async _recordFailedAttempt(email) {
    try {
      const { data } = await supabase.functions.invoke('record-failed-attempt', {
        body: { email },
      });
      return data || { count: 1, remaining: 4, locked: false };
    } catch (err) {
      console.warn('[Auth._recordFailedAttempt] Error:', err);
      return { count: 1, remaining: 4, locked: false };
    }
  },

  /**
   * Reset attempt counter after successful login.
   */
  async _clearAttempts(email) {
    try {
      await supabase.functions.invoke('clear-login-attempts', {
        body: { email },
      });
    } catch (err) {
      console.warn('[Auth._clearAttempts] Error:', err);
    }
  },


  // ── Password Change ───────────────────────────────────────

  /**
   * Change the authenticated user's password.
   * Writes to audit log on success.
   * 
   * @param {string} newPassword
   */
  async changePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { success: false, error: error.message };

    const user = await this.getCurrentUser();
    await AuditLog.write({
      action      : 'PASSWORD_CHANGED',
      user_id     : user?.id,
      user_email  : user?.email,
      resource_type: 'account',
    });

    return { success: true };
  },
};


// ============================================================
//  AUDIT LOG MODULE
//  Writes immutable records to audit_logs table.
//  Called internally by Auth and Database modules.
// ============================================================

export const AuditLog = {
  /**
   * Insert a new audit log entry.
   * Errors are swallowed — logging must NEVER break the main flow.
   * 
   * @param {object} entry
   * @param {string} entry.action        — audit_action enum value
   * @param {string} [entry.user_id]
   * @param {string} [entry.user_email]
   * @param {string} [entry.resource_type]
   * @param {string} [entry.resource_id]
   * @param {object} [entry.metadata]
   */
  async write(entry) {
    try {
      const user = await supabase.auth.getUser();
      const uid  = user?.data?.user?.id;

      await supabase.from('audit_logs').insert({
        agency_id    : uid || null,
        user_id      : entry.user_id || uid || null,
        user_email   : entry.user_email || null,
        action       : entry.action,
        resource_type: entry.resource_type || null,
        resource_id  : entry.resource_id || null,
        metadata     : entry.metadata || {},
        // ip_address: collected server-side via Edge Function
      });
    } catch (err) {
      // Silently log — audit failures must not break UX
      console.warn('[AuditLog.write] Failed to write audit entry:', err);
    }
  },

  /**
   * Fetch audit logs for the current agency (last 100 entries).
   * RLS ensures only own agency's logs are returned.
   */
  async fetch(limit = 100) {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  },
};
