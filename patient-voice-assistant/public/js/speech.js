// Assistant voice for offline / demo mode (no Realtime session): Higgs TTS 3
// first, browser speechSynthesis as a last-resort fallback.

import { api } from './api.js';

export class AssistantVoice {
  constructor() {
    this.audio = null;
    this.url = null;
    this.speakingNow = false;
    this.token = 0;
    this.voice = undefined; // server default
  }

  get speaking() {
    return this.speakingNow;
  }

  async say(text) {
    this.stop();
    const token = ++this.token;
    this.speakingNow = true;
    try {
      const buf = await api.tts(text, { voice: this.voice });
      if (token !== this.token) return;
      this.url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      this.audio = new Audio(this.url);
      await new Promise((resolve) => {
        this.audio.onended = resolve;
        this.audio.onerror = resolve;
        this.audio.onpause = resolve;
        this.audio.play().catch(resolve);
      });
    } catch {
      if (token !== this.token) return;
      await this.browserSay(text, token);
    } finally {
      if (token === this.token) this.speakingNow = false;
    }
  }

  browserSay(text, token) {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.onend = resolve;
      u.onerror = resolve;
      if (token === this.token) speechSynthesis.speak(u);
      else resolve();
    });
  }

  stop() {
    this.token++;
    this.speakingNow = false;
    if (this.audio) { try { this.audio.pause(); } catch {} this.audio = null; }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
