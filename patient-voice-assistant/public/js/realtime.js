// Higgs Realtime voice session.
//
//   1. Server mints a short-lived client secret (bai-eph-…).
//   2. Browser opens wss://api.boson.ai/v1/realtime with it as a subprotocol.
//   3. session.update configures voice, instructions, server VAD, PCM16 24 kHz.
//   4. Mic frames stream as input_audio_buffer.append.
//   5. response.output_audio.delta chunks are scheduled for gapless playback.
//   6. input_audio_buffer.speech_started → barge-in: stop playback at once.
//
// Higgs Realtime is protocol-compatible with the OpenAI Realtime API, so the
// event names mirror that schema. The session shape must be exact — an
// invalid config closes the socket.

import { api } from './api.js';
import { SAMPLE_RATE, floatToPcm16, pcm16ToBase64, bytesFromBase64, rms } from './audio.js';

const WS_URL = 'wss://api.boson.ai/v1/realtime?model=higgs-realtime';

export class RealtimeSession {
  constructor(handlers = {}) {
    this.h = handlers;
    this.ws = null;
    this.ctx = null;
    this.micStream = null;
    this.micSource = null;
    this.micNode = null;
    this.outGain = null;
    this.playHead = 0;
    this.scheduled = [];
    this.outputUntil = 0;
    this.micLevel = 0;
    this.injecting = false;
    this.micPaused = false;
    this.instructions = '';
    this.voice = 'default';
    this.responseActive = false;
    this.requestedAt = 0; // a response.create is in flight (until response.created)
    this.lastCreatedAt = 0;
    this.lastResponseAt = 0;
    this.assistantText = '';
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  // True while assistant audio is (or is about to be) audible.
  get speaking() {
    return this.scheduled.length > 0 || performance.now() < this.outputUntil;
  }

  emit(name, ...args) {
    this.h[name]?.(...args);
  }

  async connect({ instructions, voice = 'default', expirySeconds = 900 }) {
    this.instructions = instructions;
    this.voice = voice;
    this.emit('onStatus', 'requesting key…');
    const secret = await api.clientSecret(expirySeconds);
    const key = secret.value || secret.client_secret?.value;
    if (!key) throw new Error('No client secret returned by server.');

    // Start audio first so a mic-permission failure doesn't leave a dangling socket.
    await this.startAudio();

    this.emit('onStatus', 'connecting…');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, ['realtime', `openai-insecure-api-key.${key}`, 'openai-beta.realtime-v1']);
      this.ws = ws;
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        this.sendSession();
        resolve();
      });
      ws.addEventListener('message', (e) => this.onMessage(e));
      ws.addEventListener('error', () => {
        if (!opened) reject(new Error('WebSocket connection failed.'));
        else this.emit('onError', 'WebSocket error');
      });
      ws.addEventListener('close', (e) => {
        if (!opened) reject(new Error(`WebSocket closed (${e.code}) ${e.reason || ''}`.trim()));
        this.teardownAudio();
        this.ws = null;
        this.emit('onClose', e);
      });
    }).catch((err) => {
      this.teardownAudio();
      throw err;
    });
  }

  sessionConfig() {
    return {
      type: 'realtime',
      model: 'higgs-realtime',
      instructions: this.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          transcription: { model: 'higgs-stt-3.1', language: null },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.55,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            min_speech_duration: 0.125,
            // The app decides when Ava speaks: it reads the patient's words,
            // updates the clinic state and instructions, then calls reply().
            // Otherwise Higgs starts answering before the transcript arrives.
            create_response: false,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          voice: this.voice,
        },
      },
      temperature: 0.3,
      max_output_tokens: 'inf',
    };
  }

  sendSession() {
    this.send({ type: 'session.update', session: this.sessionConfig() });
  }

  // Re-send the full (identically shaped) session with fresh instructions.
  updateInstructions(instructions) {
    if (instructions === this.instructions) return;
    this.instructions = instructions;
    if (this.connected) this.sendSession();
  }

  // Stop streaming the mic (e.g. while the payment screen is open). On pause,
  // ~0.8 s of silence lets server VAD close any half-spoken turn.
  setMicPaused(paused) {
    if (paused === this.micPaused) return;
    this.micPaused = paused;
    if (paused && this.connected && !this.injecting) {
      const silence = new Int16Array(Math.round(SAMPLE_RATE * 0.8));
      this.send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(silence) });
    }
  }

  // Answer the patient's last turn (instructions must already be up to date).
  reply() {
    // A response that went quiet for 12 s without finishing (e.g. cut off by
    // barge-in with no response.done) shouldn't block Ava forever.
    if (this.responseActive && Date.now() - this.lastResponseAt > 12000) this.responseActive = false;
    if (!this.connected || this.responseActive || Date.now() - this.requestedAt < 2500) return false;
    this.requestedAt = Date.now();
    this.send({ type: 'response.create' });
    return true;
  }

  // Make the model speak now (after on-screen actions / safety-net alerts).
  // Higgs rejects a bare response.create when the assistant spoke last
  // ("No user input"), so the event goes in as a short text user item first.
  prompt(note) {
    if (!this.connected || this.responseActive || Date.now() - this.requestedAt < 4000) return false;
    this.requestedAt = Date.now();
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: note }] },
    });
    this.send({ type: 'response.create' });
    return true;
  }

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  onMessage(evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    switch (msg.type) {
      case 'session.created':
      case 'session.updated':
        this.emit('onStatus', 'live');
        break;

      case 'input_audio_buffer.speech_started':
        this.stopPlayback(); // barge-in
        this.emit('onSpeechStarted');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('onSpeechStopped');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (msg.delta) this.emit('onUserDelta', msg.delta, msg.item_id);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) this.emit('onUserFinal', msg.transcript, msg.item_id);
        break;

      case 'response.created':
        this.requestedAt = 0;
        this.lastCreatedAt = Date.now();
        this.lastResponseAt = Date.now();
        this.responseActive = true;
        this.assistantText = '';
        this.emit('onResponseStart');
        break;

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.lastResponseAt = Date.now();
        if (msg.delta) this.playChunk(msg.delta);
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (msg.delta) {
          this.assistantText += msg.delta;
          this.emit('onAssistantDelta', msg.delta);
        }
        break;

      case 'response.done':
      case 'response.cancelled':
        this.responseActive = false;
        this.emit('onResponseDone', this.assistantText, msg.type === 'response.cancelled' ? 'cancelled' : msg.response?.status);
        break;

      case 'error':
        this.requestedAt = 0;
        this.emit('onError', `${msg.error?.type || 'error'}: ${msg.error?.message || 'Realtime error'}`, msg.error);
        break;
    }
  }

  // ---- Audio graph ---------------------------------------------------------
  async startAudio() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    this.playHead = this.ctx.currentTime;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.outGain = this.ctx.createGain();
    this.outGain.connect(this.ctx.destination);

    // ScriptProcessor is deprecated but universally available with no worklet file.
    this.micNode = this.ctx.createScriptProcessor(4096, 1, 1);
    this.micNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.micLevel = rms(input);
      // Pause the mic while a demo phrase is being injected so streams don't interleave.
      if (!this.connected || this.injecting || this.micPaused) return;
      this.send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(floatToPcm16(input)) });
    };
    this.micSource.connect(this.micNode);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.micNode.connect(mute);
    mute.connect(this.ctx.destination);
  }

  playChunk(base64) {
    if (!this.ctx) return;
    const bytes = bytesFromBase64(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 32768;
    const buffer = this.ctx.createBuffer(1, float.length, SAMPLE_RATE);
    buffer.copyToChannel(float, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outGain);
    const now = this.ctx.currentTime;
    if (this.playHead < now) this.playHead = now;
    src.start(this.playHead);
    this.playHead += buffer.duration;
    this.outputUntil = performance.now() + (this.playHead - now) * 1000 + 150;
    this.scheduled.push(src);
    src.onended = () => { this.scheduled = this.scheduled.filter((s) => s !== src); };
  }

  stopPlayback() {
    this.scheduled.forEach((s) => { try { s.stop(); } catch {} });
    this.scheduled = [];
    this.outputUntil = 0;
    if (this.ctx) this.playHead = this.ctx.currentTime;
  }

  // Stream pre-recorded PCM16 (a TTS-rendered demo phrase) as if spoken into
  // the mic, followed by silence so server VAD closes the turn.
  async injectPcm(pcm16) {
    if (!this.connected) throw new Error('Not connected');
    this.injecting = true;
    try {
      const chunk = SAMPLE_RATE / 10; // 100 ms
      const silence = new Int16Array(SAMPLE_RATE * 1.2);
      const all = new Int16Array(pcm16.length + silence.length);
      all.set(pcm16);
      for (let i = 0; i < all.length; i += chunk) {
        if (!this.connected) break;
        this.send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(all.subarray(i, i + chunk)) });
        await new Promise((r) => setTimeout(r, 50)); // ~2x real time
      }
    } finally {
      this.injecting = false;
    }
  }

  teardownAudio() {
    this.stopPlayback();
    try { this.micNode?.disconnect(); } catch {}
    try { this.micSource?.disconnect(); } catch {}
    try { this.outGain?.disconnect(); } catch {}
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = this.micStream = this.micSource = this.micNode = this.outGain = null;
    this.micLevel = 0;
    this.responseActive = false;
  }

  disconnect() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.teardownAudio();
  }
}
