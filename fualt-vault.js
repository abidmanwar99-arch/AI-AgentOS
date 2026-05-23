// ============================================================
// AgentOS Circuit-Breaker Fail-Safe Vault Module
// Connection: Pulls safely from public.webhook_events table schema
// ============================================================

window.renderFailSafeVaultView = async function() {
    const viewport = document.getElementById('active-viewport-view');
    if (!viewport || !window.AgentOS.sb) return;

    try {
        // Fetch captured payloads directly from your real public.webhook_events table
        const { data: vaultedLeads } = await window.AgentOS.sb
            .from('webhook_events')
            .select('*, workflows(webhook_url)')
            .order('received_at', { ascending: false });

        viewport.innerHTML = `
            <div class="mb-6">
                <h1 class="text-2xl font-black text-white uppercase">Circuit-Breaker Fail-Safe Vault</h1>
                <p class="text-xs text-slate-400 mt-1">Loss Prevention Layer: Intercepting and preserving webhook events data.</p>
            </div>
            <div class="card-surface rounded-xl bg-slate-900 p-4">
                <table class="w-full text-left text-xs font-mono text-slate-300">
                    <thead>
                        <tr class="text-slate-500 border-b border-slate-800">
                            <th class="p-2">Timestamp</th>
                            <th class="p-2">Event Status</th>
                            <th class="p-2 text-right">Action Gateway</th>
                        </tr>
                    </thead>
                    <tbody id="vault-records-rows"></tbody>
                </table>
            </div>
        `;

        const tbody = document.getElementById('vault-records-rows');
        if(vaultedLeads && tbody) {
            vaultedLeads.forEach(record => {
                const tr = document.createElement('tr');
                // Maps payload fields to the real schema parameters (received_at, event_type)
                tr.innerHTML = `
                    <td class="p-2">${new Date(record.received_at).toLocaleString()}</td>
                    <td class="p-2 text-red-400 font-bold uppercase">${record.event_type || 'PIPELINE_DROP'}</td>
                    <td class="p-2 text-right">
                        <button onclick="executeVaultLeadPipelineReSync('${record.id}', '${record.workflows?.webhook_url || ''}')" class="bg-emerald-600 text-slate-950 px-2.5 py-1 rounded font-bold text-[10px] uppercase tracking-wider">Re-Sync</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch (err) { console.error(err); }
};

window.executeVaultLeadPipelineReSync = async function(vaultRecordId, targetWebhookUrl) {
    if (!targetWebhookUrl || targetWebhookUrl === '') { alert("Webhook Route Missing."); return; }
    try {
        const { data: record } = await window.AgentOS.sb.from('webhook_events').select('payload').eq('id', vaultRecordId).single();
        const response = await fetch(targetWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record.payload)
        });
        if (response.ok) {
            await window.AgentOS.sb.from('webhook_events').delete().eq('id', vaultRecordId);
            alert("Payload re-processed and purged safely!");
            window.renderFailSafeVaultView();
        }
    } catch (err) { alert(err.message); }
};
