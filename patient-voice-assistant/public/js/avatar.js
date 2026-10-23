// Plays the 3 pre-rendered Higgs Avatar clips at key moments and manages
// rendering them (upload a face image → server renders + caches MP4s).

import { api } from './api.js';
import { $ } from './ui.js';

export class AvatarClips {
  constructor() {
    this.video = $('#avatarVideo');
    this.caption = $('#avatarCaption');
    this.status = {};
    this.playingNow = false;
    this.refImage = null;
    this.pollTimer = null;

    this.video.addEventListener('ended', () => this.onEnd());
    this.video.addEventListener('pause', () => this.onEnd());
    $('#clipFile').addEventListener('change', (e) => this.pickImage(e.target.files?.[0]));
    $('#clipRender').addEventListener('click', () => this.render(false));
    $('#clipRerender').addEventListener('click', () => this.render(true));
  }

  get playing() {
    return this.playingNow;
  }

  async refresh() {
    try {
      const data = await api.clips();
      this.status = data.clips;
      this.envImage = data.envImage;
      this.renderStatus();
      const busy = Object.values(this.status).some((c) => !c.ready && !['missing', 'failed'].includes(c.state));
      clearTimeout(this.pollTimer);
      if (busy) this.pollTimer = setTimeout(() => this.refresh(), 3000);
    } catch {}
  }

  renderStatus() {
    const list = $('#clipStatus');
    list.innerHTML = '';
    for (const [key, c] of Object.entries(this.status)) {
      const li = document.createElement('li');
      let state = '✗ missing';
      if (c.ready) state = '✓ ready';
      else if (c.state === 'failed') state = `✗ failed: ${c.error}`;
      else if (c.state && c.state !== 'missing') state = `⏳ ${c.state}${c.progress ? ` ${c.progress}%` : ''}`;
      li.innerHTML = `<b>${key}</b> <span class="muted">${state}</span>`;
      li.title = c.text;
      if (c.ready) {
        const btn = document.createElement('button');
        btn.className = 'link';
        btn.textContent = 'play';
        btn.onclick = () => this.play(key);
        li.append(' ', btn);
      }
      list.append(li);
    }
    const anyMissing = Object.values(this.status).some((c) => !c.ready);
    $('#clipRender').disabled = !anyMissing || (!this.refImage && !this.envImage);
  }

  async pickImage(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return this.note('Image exceeds 10 MB.');
    this.refImage = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    $('#clipPreview').src = this.refImage;
    $('#clipPreview').classList.remove('hidden');
    this.renderStatus();
  }

  async render(force) {
    try {
      this.note('Submitting avatar jobs… this takes a minute or two.');
      await api.renderClips(this.refImage, force);
      await this.refresh();
    } catch (err) {
      this.note(err.message);
    }
  }

  note(text) {
    $('#clipNote').textContent = text;
  }

  // Play a clip. Muted when the live model is already talking so the two
  // voices don't overlap (caption still shows the line).
  play(key, { muted = false } = {}) {
    const c = this.status[key];
    this.caption.textContent = c?.text ? `“${c.text}”` : '';
    this.caption.classList.toggle('hidden', !c?.text);
    if (!c?.ready) {
      // No rendered clip: flash the line as a caption only.
      clearTimeout(this.captionTimer);
      this.captionTimer = setTimeout(() => this.caption.classList.add('hidden'), 4000);
      return false;
    }
    this.video.src = c.url;
    this.video.muted = muted;
    this.video.classList.remove('hidden');
    $('#avatarPlaceholder').classList.add('hidden');
    this.playingNow = !muted;
    this.video.play().catch(() => { this.playingNow = false; });
    return true;
  }

  stop() {
    if (!this.video.paused) this.video.pause();
    this.playingNow = false;
  }

  onEnd() {
    this.playingNow = false;
    clearTimeout(this.captionTimer);
    this.captionTimer = setTimeout(() => this.caption.classList.add('hidden'), 1500);
  }
}
