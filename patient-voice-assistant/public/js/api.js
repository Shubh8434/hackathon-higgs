// Tiny client for our own backend.

async function call(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  health: () => call('GET', '/api/health'),
  state: () => call('GET', '/api/state'),
  reset: () => call('POST', '/api/reset'),
  hold: (slotId, reason, patient) => call('POST', '/api/holds', { slotId, reason, patient }),
  release: (id) => call('DELETE', `/api/holds/${encodeURIComponent(id)}`),
  pay: (id) => call('POST', `/api/bookings/${encodeURIComponent(id)}/pay`),
  updatePatient: (id, patient) => call('PATCH', `/api/bookings/${encodeURIComponent(id)}`, { patient }),
  emergency: (doctorId, reason, patient) => call('POST', '/api/emergency', { doctorId, reason, patient }),
  clientSecret: (seconds) => call('POST', '/api/realtime/client-secret', { expires_after: { seconds } }),
  clips: () => call('GET', '/api/clips'),
  renderClips: (refImage, force = false) => call('POST', '/api/clips/render', { ref_image: refImage, force }),

  // TTS returns binary audio.
  async tts(input, { voice, format = 'mp3' } = {}) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, voice, response_format: format }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || `TTS failed: ${res.status}`);
    }
    return res.arrayBuffer();
  },
};
