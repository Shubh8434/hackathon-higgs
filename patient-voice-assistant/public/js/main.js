// App wiring: Realtime session ⇄ orchestrator ⇄ UI, demo-mode fallbacks,
// avatar clips, polling, timers.

import { api } from './api.js';
import { decodeToPcm16 } from './audio.js';
import { detectModelEmergency } from './keywords.js';
import { RealtimeSession } from './realtime.js';
import { AssistantVoice } from './speech.js';
import { AvatarClips } from './avatar.js';
import { Orchestrator } from './orchestrator.js';
import {
  $, $$, addBubble, updateBubble, clearCaptions, renderCharacter, renderCards, renderDoctors,
  renderSchedule, renderPhone, renderEmergency, renderPayment, resetRenderMemory,
} from './ui.js';

const PATIENT_VOICE = 'marcus'; // voice used to "speak" demo phrases into the session
const WELCOME = "Hi, I'm Ava, your booking assistant. How can I help today?";

const voice = new AssistantVoice();
const avatar = new AvatarClips();
let clockOffset = 0; // server now - client now

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
const orch = new Orchestrator({
  onChange: () => { scheduleRender(); scheduleInstructionSync(); },
  isLive: () => rt.connected,
  say: async (text) => {
    addBubble('assistant', text, { badge: 'offline voice' });
    await waitFor(() => !avatar.playing, 6000); // let a clip finish first
    voice.say(text);
  },
  // Clips play with sound offline; muted (caption only) when the live model is
  // about to talk, so two voices never overlap.
  playClip: (key) => avatar.play(key, { muted: rt.connected }),
  nudge: (kind) => nudge(kind),
});

function waitFor(cond, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => (cond() || Date.now() - start > timeout ? resolve() : setTimeout(tick, 100));
    tick();
  });
}

// ---------------------------------------------------------------------------
// Realtime session
// ---------------------------------------------------------------------------
let userBubble = null;
let userText = '';
let assistantBubble = null;
let suppressUntil = 0; // drop the transcript of an injected demo phrase
let pendingNudge = null; // { kind, reason: 'busy' | 'user-turn' }
let userSpeaking = false;

const rt = new RealtimeSession({
  onStatus: (s) => setRtStatus(s),
  onSpeechStopped: () => { userSpeaking = false; },
  onSpeechStarted: () => {
    // Barge-in: silence everything the assistant side is playing.
    userSpeaking = true;
    voice.stop();
    avatar.stop();
    if (Date.now() < suppressUntil) return;
    userText = '';
    if (!userBubble) userBubble = addBubble('user', '', { pending: true });
  },
  onUserDelta: (delta) => {
    if (Date.now() < suppressUntil) return;
    userText += delta;
    if (!userBubble) userBubble = addBubble('user', '', { pending: true });
    updateBubble(userBubble, userText);
    orch.handleUser(userText, { final: false }); // live safety net
  },
  onUserFinal: (text) => {
    if (Date.now() < suppressUntil) {
      suppressUntil = 0;
      if (userBubble) { userBubble.remove(); userBubble = null; }
      return;
    }
    if (userBubble) updateBubble(userBubble, text, { pending: false });
    else addBubble('user', text);
    userBubble = null;
    userText = '';
    orch.handleUser(text, { final: true });
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
    orch.handleAssistant(text);
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
    // Greeting: the pre-rendered welcome clip if we have one, else the model says it.
    if (!avatar.play('welcome')) {
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
  if (!text) return;
  lastPhrase = text;
  $('#replayBtn').disabled = false;
  $('#replayBtn').title = `Replay: “${text}”`;
  voice.stop();
  avatar.stop();
  rt.stopPlayback();
  addBubble('user', text, { badge });

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
    syncInstructionsNow();
    if (!rt.prompt(text)) pendingNudge = { kind: 'demo', reason: 'busy' };
  }
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
  renderPayment(s, doctorById, holdRemaining());
  if (s.error) showError(s.error);
}

// Character state machine: alert > speaking > listening > idle.
function characterLoop() {
  let state = 'idle';
  if (orch.s.mode === 'emergency') state = 'alert';
  else if (rt.speaking || voice.speaking || avatar.playing) state = 'speaking';
  else if (rt.connected) state = 'listening';
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
  }
  $('#resetBtn').addEventListener('click', async () => {
    voice.stop();
    avatar.stop();
    resetRenderMemory();
    clearCaptions();
    hideError();
    pendingNudge = null;
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
  await poll();
  avatar.refresh();
  setInterval(poll, 3000);
  setInterval(characterLoop, 100);
}

boot();
