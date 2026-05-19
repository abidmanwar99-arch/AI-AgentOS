const SUPABASE_URL = "https://your-project-id.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-public-key-string";

window.AgentOS = {
    sb: supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY),
    currentUser: null,
    currentProfile: null,
    currentLanguage: 'en',
    currentTheme: 'dark',
    paywallIntervalCheck: null
};

window.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await window.AgentOS.sb.auth.getSession();
    if (!session) {
        window.location.href = "index.html";
        return;
    }
    window.AgentOS.currentUser = session.user;
    const emailLabel = document.getElementById('user-display-email');
    if (emailLabel) emailLabel.innerText = session.user.email;

    await window.AgentOS.synchronizeStateMetadata();
});

window.AgentOS.synchronizeStateMetadata = async function() {
    if (!window.AgentOS.currentUser) return;
    const { data: profile } = await window.AgentOS.sb
        .from('agency_profiles')
        .select('*')
        .eq('id', window.AgentOS.currentUser.id)
        .single();

    if (profile) {
        window.AgentOS.currentProfile = profile;
        window.AgentOS.currentTheme = profile.dashboard_theme || 'dark';
        window.AgentOS.currentLanguage = profile.system_language || 'en';

        document.documentElement.setAttribute('data-theme', window.AgentOS.currentTheme);
        window.AgentOS.evaluatePaywallTimingMetrics();
    }
};

window.AgentOS.evaluatePaywallTimingMetrics = function() {
    if (!window.AgentOS.currentProfile) return;
    const executeCheck = () => {
        const remainingDays = window.AgentOS.currentProfile.trial_days_remaining;
        if (remainingDays <= 0) {
            if (window.AgentOS.paywallIntervalCheck) clearInterval(window.AgentOS.paywallIntervalCheck);
            window.AgentOS.injectHardLockoutCanvasOverlay();
        }
    };
    executeCheck();

    window.AgentOS.paywallIntervalCheck = setInterval(async () => {
        const { data: refreshedProfile } = await window.AgentOS.sb
            .from('agency_profiles')
            .select('created_at')
            .eq('id', window.AgentOS.currentUser.id)
            .single();
            
        if (refreshedProfile) {
            const creationDate = new Date(refreshedProfile.created_at);
            const currentDate = new Date();
            const elapsedDays = Math.floor((currentDate - creationDate) / (1000 * 60 * 60 * 24));
            const activeTrialComputedDays = Math.max(0, 10 - elapsedDays);
            window.AgentOS.currentProfile.trial_days_remaining = activeTrialComputedDays;
            executeCheck();
        }
    }, 3600000); 
};

window.AgentOS.injectHardLockoutCanvasOverlay = function() {
    const overlay = document.getElementById('paywall-injection-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
        <div class="glass-shell p-8 max-w-lg rounded-2xl text-center border-t-4 border-red-500 shadow-2xl mx-auto mt-20">
            <h2 class="text-2xl font-black text-white uppercase">Sandbox Runtime Expired</h2>
            <p class="text-xs text-slate-400 mt-2">Your 10-day testing loop has expired. To protect continuous network operations, nodes are paused.</p>
            <div class="my-4 p-3 rounded bg-slate-900 text-left text-[11px] font-mono text-slate-400">
                Plan Value: Growth Plan ($499/mo)
            </div>
            <a href="https://www.linkedin.com/in/abid" target="_blank" class="block w-full bg-red-600 text-white font-mono text-xs uppercase font-bold py-3.5 rounded text-center">
                Contact Architect on LinkedIn to Unlock Production
            </a>
        </div>
    `;
};
