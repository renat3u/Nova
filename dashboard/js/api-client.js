/**
 * NovaApiClient — REST API wrapper for dashboard data.
 */
class NovaApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  async _get(path, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${this.baseUrl}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
    return res.json();
  }

  async _post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
    return res.json();
  }

  async getStatus() { return this._get('/api/status'); }
  async getPressure(limit = 200) { return this._get('/api/pressure', { limit }); }
  async getTickTraces(limit = 50, reason) { return this._get('/api/traces/ticks', { limit, ...(reason ? { reason } : {}) }); }
  async getActionTraces(limit = 50) { return this._get('/api/traces/actions', { limit }); }
  async getDeliberationTraces(limit = 50, reason) { return this._get('/api/traces/deliberations', { limit, ...(reason ? { reason } : {}) }); }
  async getSilences(limit = 50) { return this._get('/api/traces/silences', { limit }); }
  async getProactiveTraces(limit = 50) { return this._get('/api/traces/proactive', { limit }); }
  async getActions(limit = 100) { return this._get('/api/actions', { limit }); }
  async getQueue() { return this._get('/api/queue'); }
  async getSystem() { return this._get('/api/system'); }
  async getConfig() { return this._get('/api/config'); }
  async resetSession() { return this._post('/api/session/reset', {}); }
  async updateConfig(patch) { return this._post('/api/config', patch); }
}
