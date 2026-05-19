window.renderAutomationAggregatorView = async function() {
    const viewport = document.getElementById('active-viewport-view');
    if (!viewport || !window.AgentOS.currentUser) return;

    try {
        const { data: clients } = await window.AgentOS.sb.from('clients').select('id');
        const { data: workflows } = await window.AgentOS.sb.from('workflows').select('*');
        const storageGB = window.AgentOS.currentProfile ? window.AgentOS.currentProfile.storage_used_gb : 0.00;
        const trialDays = window.AgentOS.currentProfile ? window.AgentOS.currentProfile.trial_days_remaining : 10;

        viewport.innerHTML = `
            <div class="flex justify-between items-center border-b border-slate-900 pb-6">
                <div>
                    <h1 class="text-2xl font-black text-white uppercase">Centralized Automation Aggregator</h1>
                </div>
                <div class="px-3 py-1.5 rounded bg-cyan-950/40 border border-cyan-500/30 text-xs font-mono text-cyan-400">
                    Trial: ${trialDays} Days Remaining
                </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
                <div class="card-surface p-5 rounded-xl bg-slate-900"><h3 class="text-white">n8n Node Grid</h3><div id="n8n-nodes-list"></div></div>
                <div class="card-surface p-5 rounded-xl bg-slate-900"><h3 class="text-white">Make.com Webhooks</h3><div id="make-nodes-list"></div></div>
                <div class="card-surface p-5 rounded-xl bg-slate-900"><h3 class="text-white">Zapier Triggers</h3><div id="zapier-nodes-list"></div></div>
            </div>
        `;
        
        const n8nList = document.getElementById('n8n-nodes-list');
        const makeList = document.getElementById('make-nodes-list');
        const zapierList = document.getElementById('zapier-nodes-list');
        if(workflows) {
            workflows.forEach(node => {
                const item = document.createElement('div');
                item.className = "p-2 bg-black text-xs text-slate-300 mt-2 rounded border border-slate-800";
                item.innerText = node.workflow_name;
                if(node.platform_type === 'n8n' && n8nList) n8nList.appendChild(item);
                if(node.platform_type === 'make' && makeList) makeList.appendChild(item);
                if(node.platform_type === 'zapier' && zapierList) zapierList.appendChild(item);
            });
        }
    } catch (err) { console.error(err); }
};
