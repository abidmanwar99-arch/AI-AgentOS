window.renderSystemOnboardingGuideView = function() {
    const viewport = document.getElementById('active-viewport-view');
    if (!viewport) return;

    viewport.innerHTML = `
        <div class="border-b border-slate-900 pb-6">
            <h1 class="text-2xl font-black text-white uppercase">System Onboarding &amp; Architectural Guide</h1>
            <p class="text-xs text-slate-400 mt-1">Deployment handbooks for real estate and senior living enterprise pipelines.</p>
        </div>
        <div class="space-y-4 mt-6">
            <div class="p-4 bg-slate-900 rounded-xl">
                <h3 class="text-sm font-bold text-white uppercase">01. External Payload Handshake</h3>
                <p class="text-xs text-slate-400 mt-1">Fire a standard HTTP POST request from n8n or Make to trigger real-time telemetry analytics monitoring hooks.</p>
            </div>
            <div class="p-4 bg-slate-900 rounded-xl">
                <h3 class="text-sm font-bold text-white uppercase">02. Intercepting Senior Living Lead Leakage</h3>
                <p class="text-xs text-slate-400 mt-1">If your webhook node drops, the background tracking engine automatically routes payload structures directly to the Fail-Safe Data Vault.</p>
            </div>
        </div>
    `;
};