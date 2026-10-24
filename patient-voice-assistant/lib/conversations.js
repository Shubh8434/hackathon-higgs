// Conversation store: one JSON file per conversation in data/conversations/,
// so a page refresh (or a shared ?c=<id> link) can restore the full chat and
// booking state. Zero dependencies; writes are atomic (tmp file + rename).

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { httpError } from './db.js';

const ID_RE = /^CONV-\d{8}-[A-Z0-9]{6}$/;
const MAX_MESSAGES = 1000;

function newId(now) {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `CONV-${ymd}-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
}

// One-line summary for the history list.
function summarize(doc) {
  const s = doc.state || {};
  const booking = s.confirmed || s.emergency || s.hold;
  return {
    mode: s.mode || 'normal',
    patient: s.patient?.name || '',
    bookingId: booking?.id || '',
    status: s.emergency ? 'emergency' : s.confirmed ? 'booked' : s.hold ? 'on hold' : 'in progress',
    when: booking?.range || '',
  };
}

export function createConversationStore({ dir, now = () => Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });

  function file(id) {
    if (!ID_RE.test(String(id))) throw httpError(400, `Invalid conversation id: ${id}`);
    return path.join(dir, `${id}.json`);
  }

  function write(doc) {
    const target = file(doc.id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
    return doc;
  }

  function get(id) {
    const f = file(id);
    if (!fs.existsSync(f)) throw httpError(404, `Conversation ${id} not found`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  function create() {
    let id;
    do { id = newId(now()); } while (fs.existsSync(file(id)));
    const t = now();
    return write({ id, createdAt: t, updatedAt: t, messages: [], state: null, summary: summarize({}) });
  }

  // Client sends the whole transcript + orchestrator state; we keep createdAt.
  function save(id, { messages, state } = {}) {
    const prev = get(id);
    const doc = {
      ...prev,
      messages: Array.isArray(messages) ? messages.slice(-MAX_MESSAGES).map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        text: String(m.text || '').slice(0, 5000),
        badge: m.badge ? String(m.badge).slice(0, 40) : '',
        at: Number(m.at) || now(),
      })) : prev.messages,
      state: state && typeof state === 'object' ? state : prev.state,
      updatedAt: now(),
    };
    doc.summary = summarize(doc);
    return write(doc);
  }

  function list() {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return { id: d.id, createdAt: d.createdAt, updatedAt: d.updatedAt, messageCount: d.messages.length, summary: d.summary };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return { create, get, save, list };
}
