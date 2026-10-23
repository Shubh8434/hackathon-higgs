// Pre-render the 3 avatar clips from the command line.
//
//   npm run render-clips -- path/to/face.png        (or an https URL)
//   npm run render-clips -- path/to/face.png --force
//
// Falls back to AVATAR_REF_IMAGE from .env when no image argument is given.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.js';
import { createBoson } from '../lib/boson.js';
import { createClipStore, resolveRefImage, CLIPS } from '../lib/clips.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(root);

const args = process.argv.slice(2);
const force = args.includes('--force');
const ref = args.find((a) => !a.startsWith('--')) || process.env.AVATAR_REF_IMAGE;

if (!process.env.BOSON_API_KEY) {
  console.error('BOSON_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}
if (!ref) {
  console.error('Usage: npm run render-clips -- <face.png | https://…/face.jpg> [--force]');
  process.exit(1);
}

const boson = createBoson({
  apiKey: process.env.BOSON_API_KEY,
  apiBase: process.env.BOSON_API_BASE || 'https://api.boson.ai/v1',
});
const store = createClipStore({
  boson,
  dir: path.join(root, 'clips'),
  voice: process.env.ASSISTANT_VOICE || 'nora',
});

const refImage = resolveRefImage(ref, process.cwd());
const existing = store.status();
const keys = Object.keys(CLIPS).filter((k) => force || !existing[k].ready);
if (!keys.length) {
  console.log('All clips already rendered. Use --force to re-render.');
  process.exit(0);
}

console.log(`Rendering ${keys.join(', ')} …`);
const results = await Promise.allSettled(keys.map((k) => store.renderOne(k, refImage)));
const failed = results.filter((r) => r.status === 'rejected').length;
console.log(failed ? `${failed} clip(s) failed.` : 'Done.');
process.exit(failed ? 1 : 0);
