// App wiring: Realtime session ⇄ orchestrator ⇄ UI, demo-mode fallbacks,
// polling, timers.

import { api } from './api.js';
import { decodeToPcm16 } from './audio.js';
import { detectModelEmergency } from './keywords.js';
import { RealtimeSession } from './realtime.js';
import { AssistantVoice } from './speech.js';
import { Orchestrator } from './orchestrator.js';
import {
  $, $$, addBubble, updateBubble, clearCaptions, renderCharacter, renderCards, renderDoctors,
  renderSchedule, renderPhone, renderEmergency, renderDetails, renderPayment, resetRenderMemory, renderCalendar,
} from './ui.js';

const PATIENT_VOICE = 'marcus'; // voice used to "speak" demo phrases into the session
const WELCOME = "Hi, I'm Ava, your booking assistant. How can I help today?";

const voice = new AssistantVoice();
let clockOffset = 0; // server now - client now

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
const orch = new Orchestrator({
  onChange: () => { scheduleRender(); scheduleInstructionSync(); scheduleSave(); },
  isLive: () => rt.connected,
  say: async (text) => {
    addBubble('assistant', text, { badge: 'offline voice' });
    logMessage('assistant', text, 'offline voice');
    voice.say(text);
  },
  nudge: (kind) => nudge(kind),
  // The server's clock, so "today" and "past" match the clinic calendar.
  now: () => Date.now() + clockOffset,
  // Links each booking record to this chat (created now if it doesn't exist yet).
  conversationId: () => ensureConversation().catch(() => null),
});


// ---------------------------------------------------------------------------
// Realtime session
// ---------------------------------------------------------------------------
let userBubble = null;
let userText = '';
let assistantBubble = null;
let suppressUntil = 0; // drop the transcript of an injected demo phrase
let pendingNudge = null; // { kind, reason: 'busy' | 'user-turn' }
let userSpeaking = false;
let paymentPause = false; // payment screen open: no patient input until Done / Release
let pendingReply = false; // a patient turn is waiting for Ava's answer
let replyFallback = null;

// Ava answers a patient turn only after the orchestrator has processed it and
// her instructions carry the fresh state (see create_response: false).
function requestReply() {
  clearTimeout(replyFallback);
  if (!rt.connected || paymentPause) return;
  syncInstructionsNow();
  if (rt.reply()) pendingReply = false;
  else pendingReply = true; // retried when the current response finishes
}

// Reply once the orchestrator has finished every queued turn.
function replyAfterTurn() {
  orch.busy.then(requestReply, requestReply);
}

function dropUserBubble() {
  if (userBubble) { userBubble.remove(); userBubble = null; }
  userText = '';
}

const rt = new RealtimeSession({
  onStatus: (s) => setRtStatus(s),
  onSpeechStopped: () => {
    userSpeaking = false;
    // If no transcript arrives (STT hiccup), still answer what was heard.
    clearTimeout(replyFallback);
    if (userText.trim()) replyFallback = setTimeout(() => { if (!rt.responseActive) requestReply(); }, 5000);
  },
  onSpeechStarted: () => {
    if (paymentPause) return;
    // Barge-in: silence everything the assistant side is playing.
    userSpeaking = true;
    voice.stop();
    if (Date.now() < suppressUntil) return;
    userText = '';
    if (!userBubble) userBubble = addBubble('user', '', { pending: true });
  },
  onUserDelta: (delta) => {
    if (Date.now() < suppressUntil || paymentPause) return;
    userText += delta;
    if (!userBubble) userBubble = addBubble('user', '', { pending: true });
    updateBubble(userBubble, userText);
    orch.handleUser(userText, { final: false }); // live safety net
  },
  onUserFinal: (text) => {
    if (Date.now() < suppressUntil) {
      // Injected demo phrase: it was already handled as text; now answer it.
      suppressUntil = 0;
      if (userBubble) { userBubble.remove(); userBubble = null; }
      replyAfterTurn();
      return;
    }
    clearTimeout(replyFallback);
    if (paymentPause) { dropUserBubble(); return; }
    if (userBubble) updateBubble(userBubble, text, { pending: false });
    else addBubble('user', text);
    logMessage('user', text);
    userBubble = null;
    userText = '';
    orch.handleUser(text, { final: true });
    replyAfterTurn();
  },
  onResponseStart: () => {
    assistantBubble = null;
  },
  onAssistantDelta: () => {
    if (!assistantBubble) assistantBubble = addBubble('assistant', '', { pending: true });
    updateBubble(assistantBubble, rt.assistantText);
  },
  onResponseDone: (text) => {
    if (assistantBubble) updateBubble(assistantBubble, text, { pending: false });
    assistantBubble = null;
    logMessage('assistant', text);
    orch.handleAssistant(text);
    if (pendingReply) {
      pendingReply = false;
      pendingNudge = null;
      setTimeout(replyAfterTurn, 200);
      return;
    }
    if (pendingNudge) {
      const { kind, reason } = pendingNudge;
      pendingNudge = null;
      // A patient turn was answered with the fresh instructions already.
      if (reason === 'user-turn') return;
      // The model handled the emergency on its own — no need to re-prompt.
      if (kind === 'emergency' && detectModelEmergency(text)) return;
      setTimeout(() => nudge(kind), 200);
    }
  },
  onError: (msg) => showError(msg),
  onClose: () => {
    setLive(false);
    setRtStatus('offline — demo buttons still work');
  },
});

const NOTE = {
  welcome: (r) => `[Session started] Greet the patient with: "${r}"`,
  resume: () => '[Session resumed after a page refresh] Briefly welcome the patient back and continue exactly where the conversation left off. Do not start over.',
  emergency: (r) => `[Clinic safety system] Red-flag symptoms were detected in what the patient said. Emergency mode is active. Tell the patient now: "${r}"`,
  paid: (r) => `[Clinic screen] The patient tapped Done and the payment went through. Tell the patient: "${r}"`,
};

// Make the live model voice the orchestrator's latest line.
function nudge(kind) {
  if (!rt.connected) return;
  syncInstructionsNow();
  // The patient is mid-turn (live or injected demo audio): that turn will be
  // answered with the updated instructions, so don't stack a second response.
  if (userSpeaking || Date.now() < suppressUntil) {
    pendingNudge = { kind, reason: 'user-turn' };
    return;
  }
  const reply = orch.s.reply;
  const note = (NOTE[kind] || ((r) => `[Clinic screen update] Tell the patient: "${r}"`))(reply);
  if (!rt.prompt(note)) pendingNudge = { kind, reason: 'busy' };
}

let syncTimer = null;
function scheduleInstructionSync() {
  if (!rt.connected) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncInstructionsNow, 200);
}
function syncInstructionsNow() {
  clearTimeout(syncTimer);
  if (rt.connected) rt.updateInstructions(orch.buildInstructions());
}

async function connect() {
  const btn = $('#connectBtn');
  btn.disabled = true;
  hideError();
  voice.stop();
  try {
    await orch.refresh();
    await rt.connect({ instructions: orch.buildInstructions(), voice: $('#voiceSelect').value });
    setLive(true);
    setRtStatus('live — speak now');
    // Resuming a saved conversation: pick up where it left off, no greeting.
    if (messages.length) {
      nudge('resume');
    } else {
      orch.s.reply = WELCOME;
      nudge('welcome');
    }
  } catch (err) {
    showError(err.message);
    setRtStatus('offline — demo buttons still work');
    btn.disabled = false;
  }
}

function disconnect() {
  rt.disconnect();
  setLive(false);
  setRtStatus('offline — demo buttons still work');
}

// ---------------------------------------------------------------------------
// Demo mode: canned phrases + typed input. Live: phrase is synthesized with
// TTS and streamed into the session as patient audio. Offline: the scripted
// orchestrator answers with the TTS voice.
// ---------------------------------------------------------------------------
let lastPhrase = '';

async function sendPatientText(text, badge = 'demo') {
  text = text.trim();
  if (!text || paymentPause) return;
  lastPhrase = text;
  $('#replayBtn').disabled = false;
  $('#replayBtn').title = `Replay: “${text}”`;
  voice.stop();
  rt.stopPlayback();
  addBubble('user', text, { badge });
  logMessage('user', text, badge);

  if (!rt.connected) {
    orch.handleUser(text, { final: true });
    return;
  }

  suppressUntil = Date.now() + 15000;
  orch.handleUser(text, { final: true });
  try {
    const pcm = await decodeToPcm16(await api.tts(text, { voice: PATIENT_VOICE }));
    await rt.injectPcm(pcm);
  } catch (err) {
    // Couldn't voice it: hand the model the patient's words as text instead.
    suppressUntil = 0;
    showError(`Demo audio injection failed (${err.message}); sent the phrase as text instead.`);
    await orch.busy;
    syncInstructionsNow();
    if (!rt.prompt(text)) pendingNudge = { kind: 'demo', reason: 'busy' };
  }
}

// ---------------------------------------------------------------------------
// Conversation history: every final message + the booking state is saved to
// data/conversations/<id>.json. The id lives in the URL (?c=…) and
// localStorage, so a refresh restores the chat.
// ---------------------------------------------------------------------------
const CONV_KEY = 'pva.conversation';
let convId = null;
let messages = [];
let creating = null;
let saveTimer = null;

function logMessage(role, text, badge = '') {
  if (!String(text || '').trim()) return;
  messages.push({ role, text, badge, at: Date.now() });
  scheduleSave();
}

function setConvId(id) {
  convId = id;
  const url = new URL(location.href);
  if (id) { url.searchParams.set('c', id); localStorage.setItem(CONV_KEY, id); }
  else { url.searchParams.delete('c'); localStorage.removeItem(CONV_KEY); }
  history.replaceState(null, '', url);
  $('#convId').textContent = id || 'new';
  $('#convId').title = id ? `Saved as ${id}. Refresh or open this link to restore it.` : 'Saved once the conversation starts';
}

// Created lazily on the first message, so empty visits don't leave files.
async function ensureConversation() {
  if (convId) return convId;
  creating ||= api.createConversation().then((doc) => { setConvId(doc.id); refreshHistory(); return doc.id; }).finally(() => { creating = null; });
  return creating;
}

function scheduleSave() {
  if (!convId && !messages.length) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

async function saveNow({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  if (!messages.length && !convId) return;
  try {
    const id = await ensureConversation();
    const body = JSON.stringify({ messages, state: orch.s });
    if (keepalive) {
      fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
    } else {
      await api.saveConversation(id, JSON.parse(body));
    }
  } catch (err) {
    console.warn('Conversation save failed:', err.message);
  }
}

function startNewConversation() {
  messages = [];
  orch.resumeTranscript = [];
  setConvId(null);
}

async function restoreConversation(id) {
  const doc = await api.conversation(id);
  setConvId(doc.id);
  messages = doc.messages || [];
  clearCaptions();
  for (const m of messages) addBubble(m.role, m.text, { badge: m.badge });
  if (doc.state) Object.assign(orch.s, doc.state, { error: '' });
  orch.resumeTranscript = messages.slice(-12);
  if (messages.length) addBubble('assistant', `Conversation ${doc.id} restored. Click Start voice session to continue.`, { badge: 'restored' });
}

async function refreshHistory() {
  const sel = $('#convSelect');
  try {
    const { conversations } = await api.conversations();
    sel.innerHTML = '';
    sel.append(new Option('History…', ''));
    for (const c of conversations.slice(0, 30)) {
      const t = new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const who = c.summary?.patient ? ` · ${c.summary.patient}` : '';
      sel.append(new Option(`${t}${who} · ${c.summary?.status || ''} · ${c.id}`, c.id));
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

const doctorById = (id) => orch.doctor(id);
function holdRemaining() {
  const h = orch.s.hold;
  return h ? h.holdExpiresAt - (Date.now() + clockOffset) : null;
}

function render() {
  const snap = orch.snapshot;
  if (!snap) return;
  const s = orch.s;
  renderCards(s, doctorById, holdRemaining());
  renderDoctors(snap, s, {
    onDoctor: (id) => orch.selectDoctor(id),
    onSlot: (id) => orch.selectSlot(id),
  });
  renderSchedule(snap, doctorById);
  renderPhone(snap);
  renderEmergency(s, doctorById);
  renderDetails(s);
  renderPayment(s, doctorById, holdRemaining());
  setPaymentPause(Boolean(s.hold) && s.mode !== 'emergency' && s.awaiting === 'payment');
  if (s.error) showError(s.error);
  syncCalendar(snap, s);
}

// ---------------------------------------------------------------------------
// Availability calendar: follows the selected doctor unless the user picks
// one in its dropdown; reloads when bookings change.
// ---------------------------------------------------------------------------
const cal = { doctorId: null, month: null, date: null, data: null, manual: false, sig: '', loading: 0 };
const monthOf = (iso) => iso.slice(0, 7);
const shiftMonth = (month, n) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

function syncCalendar(snap, s) {
  const sel = $('#calDoctor');
  if (!sel.options.length) for (const d of snap.doctors) sel.append(new Option(`${d.name} · ${d.title}`, d.id));
  const want = (!cal.manual && s.doctorId) || cal.doctorId || 'patel';
  const sig = JSON.stringify(snap.bookings.map((b) => [b.id, b.slotId, b.status]));
  if (want !== cal.doctorId) { cal.doctorId = want; cal.date = null; loadCalendar(); }
  else if (sig !== cal.sig) { cal.sig = sig; loadCalendar(); }
  else drawCalendar();
}

async function loadCalendar() {
  const snap = orch.snapshot;
  if (!snap || !cal.doctorId) return;
  cal.month ||= monthOf(snap.today);
  $('#calDoctor').value = cal.doctorId;
  const ticket = ++cal.loading;
  try {
    const data = await api.availability(cal.doctorId, cal.month);
    if (ticket !== cal.loading) return; // a newer request superseded this one
    cal.data = data;
    if (!cal.date || !data.days.some((d) => d.date === cal.date && ['open', 'full'].includes(d.status))) {
      cal.date = data.days.find((d) => d.status === 'open')?.date || null;
    }
  } catch (err) {
    cal.data = null;
    $('#calDay').textContent = err.status === 404
      ? 'Calendar unavailable: the server is running an older version. Restart it (npm start) and reload.'
      : `Calendar failed to load: ${err.message}`;
    return;
  }
  drawCalendar();
}

function drawCalendar() {
  const s = orch.s;
  renderCalendar(cal.data, {
    selectedDate: cal.date,
    disabled: s.mode === 'emergency' || Boolean(s.confirmed) || paymentPause,
    onDay: (date) => { cal.date = date; drawCalendar(); },
    onSlot: (id) => orch.selectSlot(id),
  });
  const today = orch.snapshot && monthOf(orch.snapshot.today);
  $('#calPrev').disabled = !cal.data || cal.month <= today;
  $('#calNext').disabled = !cal.data || cal.month >= monthOf(cal.data.horizon);
}

function updateClock() {
  $('#clock').textContent = new Date(Date.now() + clockOffset)
    .toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// While the payment screen is up the conversation waits: mic, demo phrases and
// typing are off until the patient taps Done or Release hold.
function setPaymentPause(on) {
  if (on === paymentPause) return;
  paymentPause = on;
  rt.setMicPaused(on);
  if (on) { userSpeaking = false; dropUserBubble(); }
  $$('.demo [data-phrase], #replayBtn, #typeInput, #typeForm button').forEach((n) => { n.disabled = on || (n.id === 'replayBtn' && !lastPhrase); });
  $('#typeInput').placeholder = on ? 'Paused: tap Done or Release hold on the payment screen…' : 'Type as the patient and press Enter…';
  if (rt.connected) setRtStatus(on ? 'paused: waiting for the payment screen' : 'live, speak now');
}

// Character state machine: alert > speaking > listening > idle.
function characterLoop() {
  let state = 'idle';
  if (orch.s.mode === 'emergency') state = 'alert';
  else if (rt.speaking || voice.speaking) state = 'speaking';
  else if (rt.connected && !paymentPause) state = 'listening';
  renderCharacter(state);

  const level = Math.min(1, rt.micLevel * 12);
  $('#micMeter span').style.width = `${Math.round(level * 100)}%`;

  if (orch.s.hold) {
    renderCards(orch.s, doctorById, holdRemaining());
    renderPayment(orch.s, doctorById, holdRemaining());
  }
}

// ---------------------------------------------------------------------------
// Header: status, timer, cost
// ---------------------------------------------------------------------------
let sessionStart = 0;
let timerId = null;

function setLive(live) {
  $('#connectBtn').classList.toggle('hidden', live);
  $('#connectBtn').disabled = false;
  $('#disconnectBtn').classList.toggle('hidden', !live);
  $('#voiceSelect').disabled = live;
  $('#modePill').textContent = live ? 'LIVE · Higgs Realtime' : 'OFFLINE · demo voice';
  $('#modePill').className = `pill-status ${live ? 'live' : ''}`;
  clearInterval(timerId);
  if (live) {
    sessionStart = Date.now();
    timerId = setInterval(updateTimer, 1000);
    updateTimer();
  }
}

// Boson docs: roughly $0.05–$0.10 per 5-minute call → $0.01–$0.02 per minute.
function updateTimer() {
  const sec = Math.floor((Date.now() - sessionStart) / 1000);
  const min = sec / 60;
  $('#sessionTimer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  $('#sessionCost').textContent = `est. $${(min * 0.01).toFixed(3)}–$${(min * 0.02).toFixed(3)}`;
}

function setRtStatus(text) {
  $('#rtStatus').textContent = text;
}

function showError(msg) {
  $('#errorText').textContent = msg;
  $('#errorBox').classList.remove('hidden');
}
function hideError() {
  $('#errorBox').classList.add('hidden');
  orch.s.error = '';
}

// ---------------------------------------------------------------------------
// Backup video
// ---------------------------------------------------------------------------
async function openBackup() {
  const modal = $('#backupModal');
  const video = $('#backupVideo');
  const res = await fetch('/backup/backup-demo.mp4', { method: 'HEAD' }).catch(() => null);
  const ok = res?.ok;
  video.classList.toggle('hidden', !ok);
  $('#backupMissing').classList.toggle('hidden', ok);
  if (ok) { video.src = '/backup/backup-demo.mp4'; video.currentTime = 0; video.play().catch(() => {}); }
  modal.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function poll() {
  try {
    const snap = await api.state();
    clockOffset = snap.now - Date.now();
    orch.applyState(snap);
  } catch {}
}

function bind() {
  $('#connectBtn').addEventListener('click', connect);
  $('#disconnectBtn').addEventListener('click', disconnect);
  $$('[data-phrase]').forEach((b) => b.addEventListener('click', () => sendPatientText(b.dataset.phrase)));
  $('#replayBtn').addEventListener('click', () => lastPhrase && sendPatientText(lastPhrase, 'replay'));
  $('#typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#typeInput');
    sendPatientText(input.value, 'typed');
    input.value = '';
  });
  $('#payDone').addEventListener('click', () => orch.pay());
  $('#payCancel').addEventListener('click', () => orch.cancelHold());
  $('#manualEmergency').addEventListener('click', () => orch.manualEmergency());
  for (const f of ['name', 'address', 'phone']) {
    $(`#er_${f}`).addEventListener('change', (e) => orch.setPatientField(f, e.target.value));
    $(`#nd_${f}`).addEventListener('change', (e) => orch.setPatientField(f, e.target.value));
  }
  $('#resetBtn').addEventListener('click', async () => {
    voice.stop();
    resetRenderMemory();
    clearCaptions();
    hideError();
    pendingNudge = null;
    startNewConversation();
    cal.manual = false;
    await orch.reset();
    syncInstructionsNow();
  });
  $('#backupBtn').addEventListener('click', openBackup);
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
    const modal = b.closest('.modal');
    modal.classList.add('hidden');
    modal.querySelector('video')?.pause();
  }));
  $('#errorClose').addEventListener('click', hideError);
  $('#calDoctor').addEventListener('change', (e) => { cal.manual = true; cal.doctorId = e.target.value; cal.date = null; loadCalendar(); });
  $('#calPrev').addEventListener('click', () => { cal.month = shiftMonth(cal.month, -1); cal.date = null; loadCalendar(); });
  $('#calNext').addEventListener('click', () => { cal.month = shiftMonth(cal.month, 1); cal.date = null; loadCalendar(); });
  $('#convSelect').addEventListener('change', (e) => {
    if (!e.target.value) return;
    location.href = `${location.pathname}?c=${encodeURIComponent(e.target.value)}`;
  });
  window.addEventListener('pagehide', () => { if (convId || messages.length) saveNow({ keepalive: true }); });
}

async function boot() {
  bind();
  clearCaptions();
  setLive(false);
  setRtStatus('offline — demo buttons still work');
  try {
    const h = await api.health();
    $('#keyDot').className = `dot ${h.keyConfigured ? 'good' : 'bad'}`;
    $('#keyLabel').textContent = h.keyConfigured ? 'API key configured' : 'No API key — see .env';
  } catch {
    $('#keyDot').className = 'dot bad';
    $('#keyLabel').textContent = 'server unreachable';
  }
  const wanted = new URL(location.href).searchParams.get('c') || localStorage.getItem(CONV_KEY);
  if (wanted) {
    try { await restoreConversation(wanted); } catch { startNewConversation(); }
  } else {
    setConvId(null);
  }
  refreshHistory();
  await poll();
  setInterval(poll, 3000);
  setInterval(characterLoop, 100);
  updateClock();
  setInterval(updateClock, 1000);
  // Keep Ava's "current date and time" fresh during a long session.
  setInterval(scheduleInstructionSync, 30_000);
}

boot();
