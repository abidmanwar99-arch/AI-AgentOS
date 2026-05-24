// ============================================
// AGENT.OS — SECURITY CLIENT
// File: security-client.js
// Include in EVERY dashboard page:
// <script src="security-client.js"></script>
// ============================================

const SUPABASE_URL = 'sb_secret_MzJNh5toWkGlRnwQBf-NGw_Wt66EXsa';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzZ3pnamlkYml1d2dwcGp5dmRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NDkxMzEsImV4cCI6MjA5NDQyNTEzMX0.5JvMPJjl5rc8eFCU3FTzMDrtB6B4sY923U19BJN6Dgo';
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/verify-trial`;
const LINKEDIN_URL = 'https://www.linkedin.com/in/abid-anwar-m-anwar-b4b2643a9';

// ============================================
// SKELETON LOADER STYLES
// Injected automatically — no extra CSS file needed
// ============================================
const SKELETON_CSS = `
  .sk {
    background: linear-gradient(90deg, var(--border,#0d2235) 25%, rgba(0,212,255,0.06) 50%, var(--border,#0d2235) 75%);
    background-size: 200% 100%;
    animation: skShimmer 1.4s infinite;
    border-radius: 6px;
  }
  @keyframes skShimmer {
    from { background-position: 200% 0; }
    to   { background-position: -200% 0; }
  }
  .sk-text  { height: 14px; margin-bottom: 8px; }
  .sk-text.w30 { width: 30%; }
  .sk-text.w60 { width: 60%; }
  .sk-text.w80 { width: 80%; }
  .sk-text.w100{ width: 100%; }
  .sk-box   { height: 80px; width: 100%; margin-bottom: 12px; }
  .sk-stat  { height: 72px; border-radius: 10px; }
  .sk-row   { height: 44px; width: 100%; margin-bottom: 8px; border-radius: 6px; }
  .sk-circle{ border-radius: 50%; }

  /* PAGE BLOCK OVERLAY — shown while verifying */
  #agentOsGuard {
    position: fixed; inset: 0; z-index: 9999;
    background: #020810;
    display: flex; align-items: center; justify-content: center;
    flex-direction: column; gap: 16px;
    transition: opacity 0.5s, visibility 0.5s;
  }
  #agentOsGuard.hidden { opacity: 0; visibility: hidden; pointer-events: none; }
  .guard-logo {
    font-family: 'Orbitron', monospace;
    font-size: 22px; font-weight: 900; letter-spacing: 4px; color: #e8f4f8;
  }
  .guard-logo span { color: #00d4ff; }
  .guard-bar {
    width: 180px; height: 2px;
    background: #0d2235; border-radius: 2px; overflow: hidden;
  }
  .guard-fill {
    height: 100%;
    background: linear-gradient(90deg, #00d4ff, #00ff88);
    border-radius: 2px;
    animation: guardFill 1.6s ease forwards;
  }
  @keyframes guardFill { from { width: 0; } to { width: 100%; } }
  .guard-status {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; color: #6a8fa8; letter-spacing: 3px;
  }
`;

// ============================================
// INJECT STYLES
// ============================================
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = SKELETON_CSS;
  document.head.appendChild(style);
})();

// ============================================
// INJECT GUARD OVERLAY
// Shown immediately — blocks content until verified
// ============================================
(function injectGuard() {
  const guard = document.createElement('div');
  guard.id = 'agentOsGuard';
  guard.innerHTML = `
    <div class="guard-logo">AGENT<span>.OS</span></div>
    <div class="guard-bar"><div class="guard-fill"></div></div>
    <div class="guard-status" id="guardStatus">VERIFYING SESSION...</div>
  `;
  document.body.prepend(guard);
})();

// ============================================
// MAIN SECURITY BOOT
// Called on every page load
// ============================================
async function agentOsBoot() {
  const guard = document.getElementById('agentOsGuard');
  const status = document.getElementById('guardStatus');

  try {
    // Step 1: Get Supabase session
    status.textContent = 'CHECKING AUTH TOKEN...';
    const { createClient } = supabase;
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { session } } = await sb.auth.getSession();

    // No session → back to login
    if (!session) {
      status.textContent = 'NO SESSION — REDIRECTING...';
      setTimeout(() => window.location.href = 'index.html', 800);
      return;
    }

    // Step 2: Call Edge Function — server-side trial verification
    status.textContent = 'VERIFYING TRIAL STATUS...';
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    // Step 3: Handle server response
    if (result.code === 403 || result.error === 'TRIAL_EXPIRED') {
      // HARD BLOCK — trial expired on SERVER
      status.textContent = 'TRIAL EXPIRED — REDIRECTING...';
      setTimeout(() => window.location.href = 'paywall.html', 600);
      return;
    }

    if (result.code === 401) {
      // Invalid token
      status.textContent = 'SESSION INVALID — REDIRECTING...';
      await sb.auth.signOut();
      setTimeout(() => window.location.href = 'index.html', 600);
      return;
    }

    if (result.code !== 200) {
      // Any other server error
      status.textContent = 'SERVER ERROR — RETRYING...';
      setTimeout(() => window.location.reload(), 2000);
      return;
    }

    // Step 4: ACCESS GRANTED
    status.textContent = 'ACCESS GRANTED ✓';

    // Show trial warning banner if 3 days or less
    if (result.trial_warning) {
      showTrialWarning(result.days_remaining);
    }

    // Store verified data in memory (NOT localStorage — more secure)
    window.__agentOS = {
      userId: result.user_id,
      agencyId: result.agency_id,
      fullName: result.full_name,
      daysRemaining: result.days_remaining,
      serverTime: result.server_time,
      verified: true
    };

    // Update trial display in topbar if element exists
    const trialNum = document.getElementById('trialNum');
    if (trialNum) trialNum.textContent = result.days_remaining;

    // Hide guard overlay smoothly
    setTimeout(() => {
      guard.classList.add('hidden');
      // Show skeleton loaders while real data loads
      showSkeletons();
    }, 400);

  } catch (err) {
    // Network error — show retry
    const status = document.getElementById('guardStatus');
    if (status) status.textContent = 'CONNECTION ERROR — RETRYING...';
    setTimeout(() => window.location.reload(), 3000);
  }
}

// ============================================
// SKELETON LOADERS
// Shown after auth passes, while Supabase data loads
// ============================================
function showSkeletons() {
  // Stats grid skeletons
  const statsGrid = document.querySelector('.stats-grid');
  if (statsGrid) {
    statsGrid.querySelectorAll('.sg-card').forEach(card => {
      const val = card.querySelector('.sg-val');
      if (val && val.textContent === '—') {
        val.innerHTML = '<div class="sk sk-text w60"></div>';
      }
    });
  }

  // Profile name skeleton
  const profName = document.getElementById('profName');
  if (profName && profName.textContent === 'LOADING...') {
    profName.innerHTML = '<div class="sk sk-text w80"></div>';
  }

  // Leads table skeleton
  const leadsMini = document.getElementById('leadsMini');
  if (leadsMini) {
    const hasReal = leadsMini.querySelector('.lead-row');
    if (!hasReal) {
      leadsMini.innerHTML = `
        <div style="padding:12px 16px;">
          ${[1,2,3].map(()=>`
            <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border,#0d2235);">
              <div class="sk sk-text" style="width:25%;height:12px;"></div>
              <div class="sk sk-text" style="width:20%;height:12px;"></div>
              <div class="sk sk-text" style="width:15%;height:12px;"></div>
              <div class="sk sk-text" style="width:12%;height:12px;"></div>
              <div class="sk sk-text" style="width:18%;height:12px;"></div>
            </div>
          `).join('')}
        </div>`;
    }
  }

  // Data usage bars skeleton
  ['duDBBar','duAPIBar','duFileBar','duBWBar'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.style.width === '0%') {
      el.classList.add('sk');
      el.style.width = '100%';
      setTimeout(() => {
        el.classList.remove('sk');
      }, 2000);
    }
  });
}

// ============================================
// TRIAL WARNING BANNER
// Shows when 3 days or less remaining
// ============================================
function showTrialWarning(days) {
  // Don't show if already exists
  if (document.getElementById('trialWarningBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'trialWarningBanner';
  banner.style.cssText = `
    position: fixed; top: 58px; left: 0; right: 0; z-index: 200;
    background: linear-gradient(90deg, rgba(255,107,53,0.12), rgba(255,51,85,0.12));
    border-bottom: 1px solid rgba(255,51,85,0.25);
    padding: 8px 20px;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
    font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 1px;
    animation: slideDown 0.4s ease;
  `;
  banner.innerHTML = `
    <style>@keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}</style>
    <span style="color:rgba(255,107,53,0.9);">
      ⚠ TRIAL EXPIRES IN <strong style="color:#ff3355">${days} DAY${days!==1?'S':''}</strong>
      — Your data stays safe after expiry.
    </span>
    <a
      href="${LINKEDIN_URL}"
      target="_blank"
      style="
        padding: 5px 14px;
        background: rgba(255,51,85,0.15);
        border: 1px solid rgba(255,51,85,0.3);
        color: #ff3355; border-radius: 6px;
        text-decoration: none; font-size: 9px;
        letter-spacing: 2px; white-space: nowrap;
        transition: all 0.2s;
      "
    >UPGRADE NOW →</a>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(232,244,248,0.3);cursor:pointer;font-size:14px;padding:0 4px;">×</button>
  `;

  // Insert after topbar
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.insertAdjacentElement('afterend', banner);
  else document.body.prepend(banner);

  // Adjust main content margin
  const main = document.querySelector('.main');
  if (main) main.style.paddingTop = `calc(var(--top-h, 58px) + 38px)`;
}

// ============================================
// OPTIMISTIC UI HELPER
// Use this for any action (save, update, delete)
// Shows instant feedback — syncs in background
// ============================================
window.optimisticAction = async function(btnEl, label, asyncFn) {
  const original = btnEl.textContent;
  btnEl.textContent = label || 'SAVING...';
  btnEl.disabled = true;
  btnEl.style.opacity = '0.7';

  try {
    await asyncFn();
    btnEl.textContent = '✓ SAVED';
    btnEl.style.color = 'var(--green, #00ff88)';
    setTimeout(() => {
      btnEl.textContent = original;
      btnEl.style.color = '';
      btnEl.disabled = false;
      btnEl.style.opacity = '1';
    }, 1800);
  } catch (err) {
    btnEl.textContent = '✗ FAILED — RETRY';
    btnEl.style.color = 'var(--red, #ff3355)';
    btnEl.disabled = false;
    btnEl.style.opacity = '1';
    setTimeout(() => {
      btnEl.textContent = original;
      btnEl.style.color = '';
    }, 2500);
  }
};

// ============================================
// REALTIME CONNECTION MONITOR
// Shows if Supabase realtime disconnects
// ============================================
window.monitorRealtime = function(channel) {
  let indicator = document.querySelector('.bottom-bar span:first-child');

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      if (indicator) indicator.style.color = 'var(--green, #00ff88)';
    } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
      if (indicator) indicator.style.color = 'var(--red, #ff3355)';
      // Auto retry after 3 seconds
      setTimeout(() => channel.subscribe(), 3000);
    }
  });
};

// ============================================
// BOOT — runs immediately on page load
// ============================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', agentOsBoot);
} else {
  agentOsBoot();
}
