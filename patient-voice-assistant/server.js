// Code Blue — backend.
//
// Zero npm dependencies (Node 18+ stdlib only). Responsibilities:
//   * Hold BOSON_API_KEY and mint short-lived Realtime client secrets.
//   * Proxy Higgs TTS 3 (demo phrases + offline assistant voice).
//   * Pre-render and cache the 3 Higgs Avatar clips.
//   * Run the mock clinic: doctors, slots, 5-minute holds, payment, emergency
//     pre-emption, SMS log.
//   * Serve the browser UI from public/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import { createBoson } from './lib/boson.js';
import { createDb } from './lib/db.js';
import { createClipStore, resolveRefImage } from './lib/clips.js';
import { createConversationStore } from './lib/conversations.js';
import { createBookingRecords } from './lib/records.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);

const PORT = Number(process.env.PORT || 3100);
const API_BASE = process.env.BOSON_API_BASE || 'https://api.boson.ai/v1';
const API_KEY = process.env.BOSON_API_KEY || '';
const VOICE = process.env.ASSISTANT_VOICE || 'nora';
const PUBLIC_DIR = path.join(ROOT, 'public');
const CLIPS_DIR = path.join(ROOT, 'clips');

const boson = createBoson({ apiKey: API_KEY, apiBase: API_BASE });
const records = createBookingRecords({ file: path.join(ROOT, 'data', 'bookings.json') });
const db = createDb({ onRecord: records.apply, idTaken: records.has, restore: (now) => records.upcoming(now) });
const clips = createClipStore({ boson, dir: CLIPS_DIR, voice: VOICE });
const conversations = createConversationStore({ dir: path.join(ROOT, 'data', 'conversations') });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, err) {
  sendJson(res, err.status || 500, { error: { message: err.message, type: err.type || 'error' } });
}

async function readJson(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

// Context the browser attaches to a booking (which conversation, why this doctor).
function cleanMeta(meta = {}) {
  const out = {};
  for (const k of ['conversationId', 'specialty', 'doctorSource', 'alertSource', 'alertPhrase']) {
    if (typeof meta?.[k] === 'string' && meta[k].trim()) out[k] = meta[k].trim().slice(0, 300);
  }
  return out;
}

function requireKey() {
  if (!boson.configured) {
    throw Object.assign(
      new Error('BOSON_API_KEY is not set. Copy .env.example to .env, add your key, and restart.'),
      { status: 500, type: 'config_error' }
    );
  }
}

// Static files with Range support (Safari needs it for <video>).
function serveFile(req, res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: { message: 'Not found' } });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start);
      end = Math.min(stat.size - 1, end);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.sep + rel);
  return target.startsWith(base + path.sep) || target === base ? target : null;
}

// ---------------------------------------------------------------------------
// Routes: [method, regex, handler(req, res, match)]
// ---------------------------------------------------------------------------
const routes = [
  ['GET', /^\/api\/health$/, (req, res) => {
    sendJson(res, 200, { ok: true, keyConfigured: boson.configured, apiBase: API_BASE, voice: VOICE });
  }],

  // --- Higgs Realtime: mint an ephemeral key for the browser ---------------
  ['POST', /^\/api\/realtime\/client-secret$/, async (req, res) => {
    requireKey();
    const body = await readJson(req);
    const seconds = Math.max(10, Math.min(7200, Number(body?.expires_after?.seconds) || 900));
    sendJson(res, 200, await boson.createClientSecret(seconds));
  }],

  // --- Higgs TTS 3 proxy (binary audio straight through) -------------------
  ['POST', /^\/api\/tts$/, async (req, res) => {
    requireKey();
    const body = await readJson(req);
    const input = String(body.input || '').slice(0, 5000);
    if (!input.trim()) throw Object.assign(new Error('input is required'), { status: 400 });
    const upstream = await boson.request('POST', '/audio/speech', {
      model: 'higgs-tts-3',
      input,
      voice: body.voice || VOICE,
      response_format: body.response_format || 'mp3',
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      let msg = text;
      try { msg = JSON.parse(text)?.error?.message || text; } catch {}
      throw Object.assign(new Error(msg || upstream.statusText), { status: upstream.status });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg', 'Content-Length': buf.length });
    res.end(buf);
  }],

  // --- Avatar clips --------------------------------------------------------
  ['GET', /^\/api\/clips$/, (req, res) => {
    sendJson(res, 200, { clips: clips.status(), envImage: Boolean(process.env.AVATAR_REF_IMAGE) });
  }],
  ['POST', /^\/api\/clips\/render$/, async (req, res) => {
    requireKey();
    const body = await readJson(req);
    const ref = body.ref_image || resolveRefImage(process.env.AVATAR_REF_IMAGE, ROOT);
    if (!ref) {
      throw Object.assign(new Error('Upload a face image (or set AVATAR_REF_IMAGE in .env) to render clips.'), { status: 400 });
    }
    const started = clips.renderMissing(ref, { force: Boolean(body.force) });
    sendJson(res, 200, { started, clips: clips.status() });
  }],

  // --- Mock clinic ---------------------------------------------------------
  ['GET', /^\/api\/state$/, (req, res) => sendJson(res, 200, db.snapshot())],
  ['POST', /^\/api\/reset$/, (req, res) => { db.reset(); sendJson(res, 200, db.snapshot()); }],
  ['POST', /^\/api\/holds$/, async (req, res) => {
    const body = await readJson(req);
    const booking = db.hold({ slotId: body.slotId, reason: body.reason, patient: body.patient, meta: cleanMeta(body.meta) });
    sendJson(res, 200, { booking, state: db.snapshot() });
  }],
  ['DELETE', /^\/api\/holds\/([\w-]+)$/, (req, res, m) => {
    const released = db.release(m[1]);
    sendJson(res, 200, { released, state: db.snapshot() });
  }],
  ['POST', /^\/api\/bookings\/([\w-]+)\/pay$/, (req, res, m) => {
    const booking = db.pay(m[1]);
    sendJson(res, 200, { booking, state: db.snapshot() });
  }],
  ['POST', /^\/api\/bookings\/([\w-]+)\/reschedule$/, async (req, res, m) => {
    const body = await readJson(req);
    const booking = db.reschedule(m[1], String(body.slotId || ''));
    sendJson(res, 200, { booking, state: db.snapshot() });
  }],
  ['PATCH', /^\/api\/bookings\/([\w-]+)$/, async (req, res, m) => {
    const body = await readJson(req);
    const booking = db.updatePatient(m[1], body.patient);
    sendJson(res, 200, { booking, state: db.snapshot() });
  }],
  ['POST', /^\/api\/emergency$/, async (req, res) => {
    const body = await readJson(req);
    const result = db.emergency({ doctorId: body.doctorId, reason: body.reason, patient: body.patient, meta: cleanMeta(body.meta) });
    sendJson(res, 200, { ...result, state: db.snapshot() });
  }],

  // Availability calendar: GET /api/availability/<doctor>?month=YYYY-MM
  ['GET', /^\/api\/availability\/([\w-]+)$/, (req, res, m) => {
    const month = new URL(req.url, 'http://localhost').searchParams.get('month');
    sendJson(res, 200, db.availability(m[1], month));
  }],

  // --- Bookings database (data/bookings.json) ------------------------------
  ['GET', /^\/api\/booking-records$/, (req, res) => sendJson(res, 200, { bookings: records.list() })],
  ['GET', /^\/api\/booking-records\/([\w-]+)$/, (req, res, m) => {
    const record = records.get(m[1]);
    if (!record) throw Object.assign(new Error(`Booking ${m[1]} not found`), { status: 404 });
    let conversation = null;
    try { conversation = record.conversationId ? conversations.get(record.conversationId) : null; } catch {}
    sendJson(res, 200, { ...record, conversation: conversation && { id: conversation.id, messages: conversation.messages } });
  }],

  // --- Conversation history (data/conversations/<id>.json) ----------------
  ['GET', /^\/api\/conversations$/, (req, res) => sendJson(res, 200, { conversations: conversations.list() })],
  ['POST', /^\/api\/conversations$/, (req, res) => sendJson(res, 200, conversations.create())],
  ['GET', /^\/api\/conversations\/([\w-]+)$/, (req, res, m) => sendJson(res, 200, conversations.get(m[1]))],
  ['PUT', /^\/api\/conversations\/([\w-]+)$/, async (req, res, m) => {
    const body = await readJson(req);
    const doc = conversations.save(m[1], body);
    sendJson(res, 200, { id: doc.id, updatedAt: doc.updatedAt });
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      for (const [method, re, handler] of routes) {
        const m = re.exec(pathname);
        if (m && method === req.method) return await handler(req, res, m);
      }
      return sendJson(res, 404, { error: { message: `No route for ${req.method} ${pathname}` } });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: { message: 'Method not allowed' } });
    }
    if (pathname.startsWith('/clips/')) {
      const file = safeJoin(CLIPS_DIR, pathname.slice('/clips/'.length));
      return file ? serveFile(req, res, file) : sendJson(res, 404, { error: { message: 'Not found' } });
    }
    const file = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
    return file ? serveFile(req, res, file) : sendJson(res, 404, { error: { message: 'Not found' } });
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendError(res, err);
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  Code Blue running at http://localhost:${PORT}`);
  console.log(`  API base: ${API_BASE}`);
  console.log(`  API key:  ${API_KEY ? 'configured ✓' : 'MISSING ✗  (copy .env.example to .env)'}\n`);
});
