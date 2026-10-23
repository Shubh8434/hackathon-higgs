import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, slotId, HOLD_MS } from '../lib/db.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('hold → pay confirms and sends a receipt SMS', () => {
  const db = createDb();
  const sid = slotId('chen', 'today', '10:00');
  const held = db.hold({ slotId: sid, reason: 'palpitations' });
  assert.equal(held.status, 'held');
  assert.throws(() => db.hold({ slotId: sid }), /taken/);
  const paid = db.pay(held.id);
  assert.equal(paid.status, 'confirmed');
  assert.equal(paid.payment, 'paid');
  const sms = db.snapshot().sms.at(-1);
  assert.equal(sms.kind, 'receipt');
  assert.match(sms.body, new RegExp(held.id));
});

test('holds expire after 5 minutes and free the slot', () => {
  const c = clock();
  const db = createDb({ now: c.now });
  const sid = slotId('kim', 'today', '14:00');
  const held = db.hold({ slotId: sid });
  c.advance(HOLD_MS - 1);
  assert.ok(db.get(held.id));
  c.advance(2);
  db.snapshot();
  assert.equal(db.get(held.id), undefined);
  assert.throws(() => db.pay(held.id), /expired/);
  assert.ok(db.hold({ slotId: sid })); // slot is free again
});

test('emergency pre-empts the first same-day slot and moves the normal booking', () => {
  const db = createDb();
  const before = db.snapshot().bookings.find((b) => b.doctorId === 'chen' && b.day === 'today' && b.time === '09:00');
  assert.ok(before, 'seeded booking at 9:00');

  const { booking, displaced } = db.emergency({ doctorId: 'chen', reason: 'chest pain' });
  assert.equal(booking.emergency, true);
  assert.equal(booking.time, '09:00');
  assert.equal(booking.payment, 'waived');
  assert.ok(booking.id.startsWith('ER-'));

  assert.equal(displaced.id, before.id);
  assert.equal(displaced.displaced, true);
  assert.deepEqual(displaced.displacedFrom, { day: 'today', time: '09:00' });
  // 09:30 and 10:30 are seeded, so the first free Chen slot is 10:00.
  assert.equal(displaced.time, '10:00');

  const kinds = db.snapshot().sms.map((s) => s.kind);
  assert.ok(kinds.includes('emergency'));
  assert.ok(kinds.includes('displaced'));

  // A second emergency takes the next non-emergency slot.
  const second = db.emergency({ doctorId: 'chen' });
  assert.equal(second.booking.time, '09:30');
});

test('updatePatient fills emergency details', () => {
  const db = createDb();
  const { booking } = db.emergency({ doctorId: 'patel' });
  db.updatePatient(booking.id, { name: 'Ana Diaz', phone: '(647) 555-0123' });
  db.updatePatient(booking.id, { address: '22 Queen St' });
  assert.deepEqual(db.get(booking.id).patient, { name: 'Ana Diaz', phone: '(647) 555-0123', address: '22 Queen St' });
});

test('reset restores the seeded schedule', () => {
  const db = createDb();
  db.emergency({ doctorId: 'patel' });
  db.reset();
  assert.ok(db.snapshot().bookings.every((b) => !b.emergency));
});
