import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../lib/conversations.js';

const tmpStore = () => createConversationStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pva-conv-')) });

test('conversations: create, save, get, list', () => {
  const store = tmpStore();
  const { id } = store.create();
  assert.match(id, /^CONV-\d{8}-[A-Z0-9]{6}$/);
  store.save(id, {
    messages: [{ role: 'user', text: 'I have back pain' }, { role: 'assistant', text: 'Dr. Kim it is.' }],
    state: { mode: 'normal', patient: { name: 'Subham Sharma' }, confirmed: { id: 'PVA-1234', range: '11:00 AM to 11:30 AM today' } },
  });
  const doc = store.get(id);
  assert.equal(doc.messages.length, 2);
  assert.equal(doc.state.patient.name, 'Subham Sharma');
  assert.deepEqual(doc.summary, { mode: 'normal', patient: 'Subham Sharma', bookingId: 'PVA-1234', status: 'booked', when: '11:00 AM to 11:30 AM today' });
  assert.equal(store.list()[0].id, id);
});

test('conversations: rejects bad or unknown ids', () => {
  const store = tmpStore();
  assert.throws(() => store.get('../../server'), { status: 400 });
  assert.throws(() => store.get('CONV-20260101-ZZZZZZ'), { status: 404 });
});
