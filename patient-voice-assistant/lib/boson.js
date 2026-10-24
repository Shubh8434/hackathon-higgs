// Thin wrapper around the Boson AI (Higgs) REST API. The long-lived key only
// ever lives here, on the server.

export function createBoson({ apiKey, apiBase }) {
  const headers = (extra = {}) => ({ Authorization: `Bearer ${apiKey}`, ...extra });

  async function request(method, path, body) {
    const init = { method, headers: headers() };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(`${apiBase}${path}`, init);
  }

  // Throws an Error carrying the upstream message + status on non-2xx.
  async function json(method, path, body) {
    const res = await request(method, path, body);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data?.error?.message || text || res.statusText);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  return {
    configured: Boolean(apiKey),
    request,
    json,
    createClientSecret: (seconds) =>
      json('POST', '/realtime/client_secrets', { expires_after: { seconds } }),
    createVideo: (body) => json('POST', '/videos', body),
    getVideo: (id) => json('GET', `/videos/${encodeURIComponent(id)}`),
    async downloadVideo(id) {
      const res = await request('GET', `/videos/${encodeURIComponent(id)}/content`);
      if (!res.ok) throw new Error(`Video download failed: ${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
