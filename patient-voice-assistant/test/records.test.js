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

test('records: a reschedule updates the slot and keeps a history', () => {
  const { records, db } = setup();
  const [a, b] = db.freeSlots('patel', { limit: 2 });
  const held = db.hold({ slotId: a.id, reason: 'cold' });
  db.pay(held.id);
  db.reschedule(held.id, b.id);
  const r = records.get(held.id);
  assert.equal(r.slot.date, b.date);
  assert.equal(r.reschedules.length, 1);
  assert.deepEqual(r.history.map((h) => h.event), ['held', 'confirmed', 'rescheduled']);
});

test('records: confirmed upcoming bookings are restored into the schedule on reset/restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pva-rec-')), 'bookings.json');
  let records = createBookingRecords({ file });
  let db = createDb({ onRecord: records.apply, idTaken: records.has, restore: (n) => records.upcoming(n) });
  const [slot] = db.freeSlots('lopez', { limit: 1 });
  const held = db.hold({ slotId: slot.id, reason: 'rash', patient: { name: 'Ana Diaz', phone: '(647) 555-0123' } });
  db.pay(held.id);
  const released = db.hold({ slotId: db.freeSlots('lopez', { limit: 1 })[0].id });
  db.release(released.id);

  db.reset(); // Reset demo keeps it
  assert.equal(db.get(held.id)?.slotId, slot.id);
  assert.equal(db.get(released.id), undefined, 'released holds are not restored');

  records = createBookingRecords({ file }); // server restart
  db = createDb({ onRecord: records.apply, idTaken: records.has, restore: (n) => records.upcoming(n) });
  const back = db.get(held.id);
  assert.equal(back.slotId, slot.id);
  assert.equal(back.payment, 'paid');
  assert.equal(back.patient.phone, '(647) 555-0123');
  assert.ok(db.reschedule(held.id, db.freeSlots('lopez', { limit: 1 })[0].id));
});
