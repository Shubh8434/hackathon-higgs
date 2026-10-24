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
  return withRanges(data);
}

const fmt = (mins) => `${Math.floor(mins / 60) % 12 || 12}:${String(mins % 60).padStart(2, '0')} ${Math.floor(mins / 60) >= 12 ? 'PM' : 'AM'}`;

// Every booking gets its 30-minute range ("11:00 AM to 11:30 AM today"),
// even from a server that doesn't send one.
function withRanges(data) {
  const fix = (b) => {
    if (!b?.time || !b.day || b.range) return;
    const [h, m] = b.time.split(':').map(Number);
    b.range = `${fmt(h * 60 + m)} to ${fmt(h * 60 + m + 30)} ${b.day}`;
  };
  fix(data?.booking);
  fix(data?.displaced);
  for (const b of data?.bookings || []) fix(b);
  for (const b of data?.state?.bookings || []) fix(b);
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
