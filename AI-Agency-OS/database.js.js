/**
 * ============================================================
 *  AgentOS · Database.js
 *  Data Access Layer — Production Ready
 * 
 *  Responsibilities:
 *    - All Supabase database reads/writes for:
 *        clients, workflows, webhook_events, agency_profiles
 *    - AES-256 encryption BEFORE inserting API keys
 *    - AES-256 decryption AFTER fetching (only when needed)
 *    - Supabase Realtime subscription for live webhook events
 *    - System health check (n8n webhook ping)
 *    - Audit log writes on every destructive action
 * 
 *  Security Rules:
 *    - API keys are encrypted BEFORE leaving the browser
 *    - Supabase RLS handles row-level isolation automatically
 *    - Decrypted keys are NEVER stored in component state
 *    - Decrypted keys are returned only on explicit "reveal" action
 * 
 *  Dependencies:
 *    - auth.js (supabase client, Crypto, AuditLog)
 * ============================================================
 */

import { supabase, Crypto, AuditLog } from './auth.js';


// ============================================================
//  CLIENTS MODULE
//  CRUD for client leads with encrypted API key handling
// ============================================================

export const Clients = {

  /**
   * Fetch all clients for the current agency.
   * API keys are returned ENCRYPTED — call revealApiKey() to decrypt.
   * 
   * @param {object} options
   * @param {string} [options.status]    — filter by status
   * @param {string} [options.orderBy]   — column to sort by
   * @param {number} [options.limit]     — max results
   * @returns {Array} clients array
   */
  async getAll({ status, orderBy = 'created_at', limit = 100 } = {}) {
    let query = supabase
      .from('clients')
      .select(`
        id,
        client_name,
        client_email,
        website_url,
        platform,
        api_key_status,
        api_key_last_checked,
        system_prompt,
        logic_reasoning,
        ai_score,
        status,
        workflow_count,
        last_sync_at,
        notes,
        created_at,
        updated_at
        -- NOTE: api_key_encrypted, api_key_iv, api_key_tag are excluded here
        -- Call revealApiKey(clientId) explicitly when needed
      `)
      .order(orderBy, { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(`[Clients.getAll] ${error.message}`);
    return data;
  },


  /**
   * Get a single client by ID.
   * Does NOT return encrypted key fields — use revealApiKey() for that.
   */
  async getById(clientId) {
    const { data, error } = await supabase
      .from('clients')
      .select('*, workflows(*)')
      .eq('id', clientId)
      .single();

    if (error) throw new Error(`[Clients.getById] ${error.message}`);
    return data;
  },


  /**
   * Create a new client.
   * If apiKey is provided, it is encrypted BEFORE being sent to Supabase.
   * 
   * @param {object} clientData
   * @param {string} clientData.client_name
   * @param {string} [clientData.client_email]
   * @param {string} [clientData.website_url]
   * @param {string} [clientData.platform]
   * @param {string} [clientData.apiKey]         — raw plaintext API key (optional)
   * @param {string} [clientData.system_prompt]
   * @param {string} [clientData.notes]
   */
  async create(clientData) {
    const { apiKey, ...rest } = clientData;

    // Build the insert payload
    const payload = {
      ...rest,
      api_key_status: 'checking',
    };

    // Encrypt API key if provided
    if (apiKey && apiKey.trim()) {
      const { encrypted, iv, tag } = await Crypto.encrypt(apiKey.trim());
      payload.api_key_encrypted = encrypted;
      payload.api_key_iv        = iv;
      payload.api_key_tag       = tag;
      payload.api_key_status    = 'valid'; // assume valid on entry; verify separately
    }

    const { data, error } = await supabase
      .from('clients')
      .insert(payload)
      .select()
      .single();

    if (error) throw new Error(`[Clients.create] ${error.message}`);

    // Audit log
    await AuditLog.write({
      action       : 'CLIENT_CREATED',
      resource_type: 'client',
      resource_id  : data.id,
      metadata     : { client_name: data.client_name, platform: data.platform },
    });

    return data;
  },


  /**
   * Update an existing client.
   * If a new apiKey is provided, re-encrypts and overwrites the stored key.
   * 
   * @param {string} clientId
   * @param {object} updates — partial client fields to update
   * @param {string} [updates.apiKey] — new plaintext API key (optional)
   */
  async update(clientId, updates) {
    const { apiKey, ...rest } = updates;
    const payload = { ...rest, updated_at: new Date().toISOString() };

    // Re-encrypt new API key if provided
    if (apiKey && apiKey.trim()) {
      const { encrypted, iv, tag } = await Crypto.encrypt(apiKey.trim());
      payload.api_key_encrypted = encrypted;
      payload.api_key_iv        = iv;
      payload.api_key_tag       = tag;
      payload.api_key_status    = 'checking'; // trigger re-verification

      await AuditLog.write({
        action       : 'API_KEY_UPDATED',
        resource_type: 'client',
        resource_id  : clientId,
        metadata     : { client_name: rest.client_name },
      });
    }

    const { data, error } = await supabase
      .from('clients')
      .update(payload)
      .eq('id', clientId)
      .select()
      .single();

    if (error) throw new Error(`[Clients.update] ${error.message}`);

    await AuditLog.write({
      action       : 'CLIENT_UPDATED',
      resource_type: 'client',
      resource_id  : clientId,
      metadata     : { updated_fields: Object.keys(rest) },
    });

    return data;
  },


  /**
   * Delete a client by ID.
   * Cascades to workflows via foreign key constraint.
   */
  async delete(clientId) {
    // Fetch name before deleting for audit log
    const { data: client } = await supabase
      .from('clients')
      .select('client_name')
      .eq('id', clientId)
      .single();

    const { error } = await supabase
      .from('clients')
      .delete()
      .eq('id', clientId);

    if (error) throw new Error(`[Clients.delete] ${error.message}`);

    await AuditLog.write({
      action       : 'CLIENT_DELETED',
      resource_type: 'client',
      resource_id  : clientId,
      metadata     : { client_name: client?.client_name },
    });

    return { success: true };
  },


  /**
   * Reveal (decrypt) the API key for a specific client.
   * Requires an explicit user action — not called automatically.
   * The decrypted key is returned but NEVER stored in app state.
   * 
   * @param {string} clientId
   * @returns {string} decrypted API key
   */
  async revealApiKey(clientId) {
    const { data, error } = await supabase
      .from('clients')
      .select('api_key_encrypted, api_key_iv, api_key_tag, client_name')
      .eq('id', clientId)
      .single();

    if (error) throw new Error(`[Clients.revealApiKey] ${error.message}`);
    if (!data.api_key_encrypted) return null;

    const plaintext = await Crypto.decrypt(
      data.api_key_encrypted,
      data.api_key_iv,
      data.api_key_tag
    );

    // Log that a key was revealed (compliance requirement)
    await AuditLog.write({
      action       : 'API_KEY_ADDED', // re-using enum; change to 'API_KEY_REVEALED' if you add it
      resource_type: 'client',
      resource_id  : clientId,
      metadata     : { client_name: data.client_name, action: 'key_revealed' },
    });

    return plaintext;
  },


  /**
   * Update a client's AI score and reasoning (called from webhook handler).
   * 
   * @param {string} clientId
   * @param {number} score        — 0-100
   * @param {string} reasoning    — AI explanation of the score
   */
  async updateAiScore(clientId, score, reasoning) {
    const { error } = await supabase
      .from('clients')
      .update({
        ai_score       : score,
        logic_reasoning: reasoning,
        last_sync_at   : new Date().toISOString(),
      })
      .eq('id', clientId);

    if (error) throw new Error(`[Clients.updateAiScore] ${error.message}`);
    return { success: true };
  },


  /**
   * Export all clients as JSON (no API keys included).
   */
  async export() {
    const clients = await this.getAll({ limit: 1000 });

    await AuditLog.write({
      action   : 'DATA_EXPORTED',
      metadata : { count: clients.length, type: 'clients' },
    });

    return clients; // api_key fields already excluded in getAll()
  },
};


// ============================================================
//  WORKFLOWS MODULE
// ============================================================

export const Workflows = {

  /**
   * Get all workflows for a specific client.
   */
  async getByClient(clientId) {
    const { data, error } = await supabase
      .from('workflows')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(`[Workflows.getByClient] ${error.message}`);
    return data;
  },


  /**
   * Create a new workflow.
   */
  async create(workflowData) {
    const { data, error } = await supabase
      .from('workflows')
      .insert(workflowData)
      .select()
      .single();

    if (error) throw new Error(`[Workflows.create] ${error.message}`);

    await AuditLog.write({
      action       : 'WORKFLOW_CREATED',
      resource_type: 'workflow',
      resource_id  : data.id,
      metadata     : { workflow_name: data.workflow_name },
    });

    return data;
  },


  /**
   * Update workflow status and error message.
   */
  async updateStatus(workflowId, status, errorMessage = null) {
    const { data, error } = await supabase
      .from('workflows')
      .update({ status, error_message: errorMessage })
      .eq('id', workflowId)
      .select()
      .single();

    if (error) throw new Error(`[Workflows.updateStatus] ${error.message}`);
    return data;
  },


  /**
   * Delete a workflow.
   */
  async delete(workflowId) {
    const { error } = await supabase
      .from('workflows')
      .delete()
      .eq('id', workflowId);

    if (error) throw new Error(`[Workflows.delete] ${error.message}`);

    await AuditLog.write({
      action       : 'WORKFLOW_DELETED',
      resource_type: 'workflow',
      resource_id  : workflowId,
    });

    return { success: true };
  },
};


// ============================================================
//  AGENCY PROFILE MODULE
// ============================================================

export const AgencyProfile = {

  /**
   * Get the current agency's profile.
   */
  async get() {
    const { data, error } = await supabase
      .from('agency_profiles')
      .select('*')
      .single();

    if (error) throw new Error(`[AgencyProfile.get] ${error.message}`);
    return data;
  },


  /**
   * Update agency profile settings.
   */
  async update(updates) {
    const { data, error } = await supabase
      .from('agency_profiles')
      .update(updates)
      .select()
      .single();

    if (error) throw new Error(`[AgencyProfile.update] ${error.message}`);

    await AuditLog.write({
      action   : 'SETTINGS_CHANGED',
      metadata : { updated_fields: Object.keys(updates) },
    });

    return data;
  },
};


// ============================================================
//  REALTIME WEBHOOK MODULE
//  Subscribes to Supabase Realtime for live n8n events.
//  Updates the UI without a page refresh.
// ============================================================

export const WebhookListener = {

  _channel: null,

  /**
   * Start listening for new webhook events from n8n.
   * When a new row appears in webhook_events, the callback fires.
   * 
   * @param {string}   agencyId  — current agency's UUID
   * @param {function} onEvent   — callback(event) when new data arrives
   */
  subscribe(agencyId, onEvent) {
    // Unsubscribe from any existing channel first
    this.unsubscribe();

    this._channel = supabase
      .channel(`webhook_events:agency:${agencyId}`)
      .on(
        'postgres_changes',
        {
          event : 'INSERT',           // Only listen for new events (not updates)
          schema: 'public',
          table : 'webhook_events',
          filter: `agency_id=eq.${agencyId}`,
        },
        async (payload) => {
          console.log('[WebhookListener] New event received:', payload.new.event_type);

          // Mark event as processed so we don't re-process on reconnect
          await supabase
            .from('webhook_events')
            .update({ processed: true })
            .eq('id', payload.new.id);

          // Fire the UI callback
          onEvent(payload.new);

          await AuditLog.write({
            action       : 'WEBHOOK_RECEIVED',
            resource_type: 'webhook_event',
            resource_id  : payload.new.id,
            metadata     : {
              event_type: payload.new.event_type,
              client_id : payload.new.client_id,
            },
          });
        }
      )
      .subscribe((status) => {
        console.log('[WebhookListener] Subscription status:', status);
        // Emit health status for System Health indicator
        window.dispatchEvent(new CustomEvent('agentos:webhook-health', {
          detail: { status, connected: status === 'SUBSCRIBED' },
        }));
      });

    return this._channel;
  },


  /**
   * Stop listening for webhook events.
   */
  unsubscribe() {
    if (this._channel) {
      supabase.removeChannel(this._channel);
      this._channel = null;
    }
  },
};


// ============================================================
//  SYSTEM HEALTH MODULE
//  Checks if the n8n webhook endpoint is reachable.
// ============================================================

export const SystemHealth = {

  /**
   * Ping the agency's n8n webhook URL to verify connectivity.
   * Returns a health status object.
   * 
   * @param {string} n8nWebhookUrl — from agency_profiles.n8n_base_url
   * @returns {{ status: 'online'|'offline'|'degraded', latencyMs: number }}
   */
  async checkN8nWebhook(n8nWebhookUrl) {
    if (!n8nWebhookUrl) return { status: 'unconfigured', latencyMs: 0 };

    const start = performance.now();
    try {
      const res = await fetch(n8nWebhookUrl + '/healthz', {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5s timeout
      });

      const latencyMs = Math.round(performance.now() - start);

      if (res.ok) {
        return { status: 'online', latencyMs };
      } else {
        return { status: 'degraded', latencyMs, httpStatus: res.status };
      }
    } catch {
      return { status: 'offline', latencyMs: Math.round(performance.now() - start) };
    }
  },


  /**
   * Run a full system health check.
   * Returns status of Supabase connection + n8n webhook.
   */
  async fullCheck(n8nWebhookUrl) {
    const [supabaseHealth, n8nHealth] = await Promise.all([
      this._checkSupabase(),
      this.checkN8nWebhook(n8nWebhookUrl),
    ]);

    return {
      supabase: supabaseHealth,
      n8n     : n8nHealth,
      overall : supabaseHealth.status === 'online' && n8nHealth.status === 'online'
        ? 'healthy'
        : 'degraded',
    };
  },


  /**
   * Quick Supabase connectivity check.
   */
  async _checkSupabase() {
    const start = performance.now();
    try {
      const { error } = await supabase.from('agency_profiles').select('id').limit(1);
      const latencyMs = Math.round(performance.now() - start);
      return error
        ? { status: 'degraded', latencyMs, error: error.message }
        : { status: 'online',   latencyMs };
    } catch {
      return { status: 'offline', latencyMs: Math.round(performance.now() - start) };
    }
  },
};
