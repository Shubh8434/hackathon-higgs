// The 3 pre-rendered Higgs Avatar clips. Rendered once, cached as MP4 files in
// clips/, and replayed at key moments (never per conversation turn).

import fs from 'node:fs';
import path from 'node:path';

// Short lines (~2-3 s of speech each). Kept generic so one render is reusable
// for every booking; the cards on screen show the specific time.
export const CLIPS = {
  welcome: "Hi, I'm Ava, your booking assistant. How can I help today?",
  emergency: "We're getting you help immediately. Stay with me.",
  confirmed: 'Your appointment is booked. Check your phone for details.',
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Accepts an http(s) URL, a data URI, or a local file path.
export function resolveRefImage(ref, baseDir) {
  if (!ref) return null;
  if (/^(https?:|data:)/i.test(ref)) return ref;
  const file = path.resolve(baseDir, ref);
  if (!fs.existsSync(file)) throw new Error(`AVATAR_REF_IMAGE file not found: ${file}`);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error('AVATAR_REF_IMAGE must be a .png, .jpg or .webp file');
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

export function createClipStore({ boson, dir, voice = 'nora', log = console.log }) {
  fs.mkdirSync(dir, { recursive: true });
  // In-flight/failed state for clips that aren't on disk yet.
  const jobs = {};

  const file = (key) => path.join(dir, `${key}.mp4`);

  function status() {
    const out = {};
    for (const [key, text] of Object.entries(CLIPS)) {
      const ready = fs.existsSync(file(key));
      out[key] = {
        text,
        ready,
        url: ready ? `/clips/${key}.mp4?v=${Math.floor(fs.statSync(file(key)).mtimeMs)}` : null,
        ...(ready ? {} : jobs[key] || { state: 'missing' }),
      };
    }
    return out;
  }

  async function renderOne(key, refImage, { size = '640x640' } = {}) {
    jobs[key] = { state: 'submitting', progress: 0 };
    try {
      const job = await boson.createVideo({
        model: 'higgs-avatar',
        ref_image: refImage,
        size,
        input_tts: { model: 'higgs-tts-3', input: CLIPS[key], voice },
      });
      log(`  [clip:${key}] job ${job.id} ${job.status}`);
      let st = job;
      while (st.status === 'queued' || st.status === 'in_progress') {
        jobs[key] = { state: st.status, progress: st.progress ?? 0, jobId: job.id };
        await new Promise((r) => setTimeout(r, 2500));
        st = await boson.getVideo(job.id);
      }
      if (st.status !== 'completed') {
        const msg = typeof st.error === 'string' ? st.error : st.error?.message || `status ${st.status}`;
        throw new Error(msg);
      }
      fs.writeFileSync(file(key), await boson.downloadVideo(job.id));
      delete jobs[key];
      log(`  [clip:${key}] saved ${file(key)}`);
    } catch (err) {
      jobs[key] = { state: 'failed', error: err.message };
      log(`  [clip:${key}] failed: ${err.message}`);
      throw err;
    }
  }

  // Kick off renders for missing clips (or all, with force). Returns at once;
  // poll status() for progress.
  function renderMissing(refImage, { force = false } = {}) {
    if (!refImage) throw new Error('A reference face image is required to render avatar clips.');
    const started = [];
    for (const key of Object.keys(CLIPS)) {
      const busy = jobs[key] && !['failed', 'missing'].includes(jobs[key].state);
      if (busy) continue;
      if (!force && fs.existsSync(file(key))) continue;
      started.push(key);
      renderOne(key, refImage).catch(() => {});
    }
    return started;
  }

  return { status, renderOne, renderMissing, file };
}
