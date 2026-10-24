import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../lib/db.js';
import { createBookingRecords } from '../lib/records.js';

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pva-rec-')), 'bookings.json');
  const records = createBookingRecords({ file });
  const db = createDb({ onRecord: records.apply, idTaken: records.has });
  return { file, records, db };
}

test('records: a paid booking keeps everything from the chat, and survives reset + reload', () => {
  const { file, records, db } = setup();
  const slot = db.freeSlots('kim', { limit: 1 })[0];
  const b = db.hold({ slotId: slot.id, reason: 'I have back pain', meta: { conversationId: 'CONV-20261023-ABC123', specialty: 'orthopedics', doctorSource: 'symptom' } });
  db.updatePatient(b.id, { name: 'Subham Sharma', address: '123 Street East', phone: '(647) 920-4548' });
  db.pay(b.id);
  db.reset();
  const r = createBookingRecords({ file }).get(b.id);
  assert.equal(r.status, 'confirmed');
  assert.deepEqual(r.patient, { name: 'Subham Sharma', address: '123 Street East', phone: '(647) 920-4548' });
  assert.equal(r.problem, 'I have back pain');
  assert.equal(r.conversationId, 'CONV-20261023-ABC123');
  assert.equal(r.slot.date, slot.date);
  assert.match(r.slot.range, /^\w+day, \w+ \d+, \d+:\d\d [AP]M to \d+:\d\d [AP]M$/);
  assert.deepEqual(r.payment, { status: 'paid', amount: 40 });
  assert.deepEqual(r.history.map((h) => h.event), ['held', 'details', 'confirmed']);
  assert.equal(records.list().length, 1);
});

test('records: emergencies note the pre-empted booking; seeded bookings are not recorded', () => {
  const { records, db } = setup();
  const { booking } = db.emergency({ doctorId: 'chen', reason: 'severe chest pain', meta: { alertSource: 'safety-net', alertPhrase: 'chest pain' } });
  const r = records.get(booking.id);
  assert.equal(r.type, 'emergency');
  assert.equal(r.emergency.detectedBy, 'safety-net');
  assert.equal(r.emergency.preempted.patient, 'Robert Hall');
  assert.equal(records.list().length, 1);
});
