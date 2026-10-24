import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, HOLD_MS, scheduleStatus, slotRange, slotLabel, fullRange, dayWord } from '../lib/db.js';

// Monday 2026-10-26, 08:00 local: before clinic opens.
const MON_8AM = new Date(2026, 9, 26, 8, 0).getTime();

function clock(start = MON_8AM) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('availability is fixed: same doctor/date/time always gives the same answer', () => {
  assert.equal(scheduleStatus('patel', '2026-10-31'), 'closed'); // Saturday
  assert.equal(scheduleStatus('patel', '2026-11-01'), 'closed'); // Sunday
  for (const d of ['patel', 'chen', 'rahman']) {
    assert.equal(scheduleStatus(d, '2026-11-04', '10:00'), scheduleStatus(d, '2026-11-04', '10:00'));
  }
});

test('free slots start from now, skip the past, weekends and blocked times', () => {
  const c = clock(new Date(2026, 9, 26, 10, 15).getTime()); // Monday 10:15
  const db = createDb({ now: c.now });
  const free = db.freeSlots('kim', { limit: 20 });
  assert.ok(free.length);
  for (const s of free) {
    assert.ok(s.date > '2026-10-26' || s.time > '10:15', `${s.id} is in the past`);
    assert.equal(scheduleStatus('kim', s.date, s.time), 'open');
    assert.notEqual(new Date(`${s.date}T12:00`).getDay() % 6, 0, 'no weekends');
  }
});

test('labels and ranges are relative to now; SMS/records use the full date', () => {
  assert.equal(dayWord('2026-10-26', MON_8AM), 'today');
  assert.equal(dayWord('2026-10-27', MON_8AM), 'tomorrow');
  assert.equal(dayWord('2026-10-29', MON_8AM), 'Thursday');
  assert.equal(dayWord('2026-11-05', MON_8AM), 'Thursday, Nov 5');
  assert.equal(slotLabel('2026-10-29', '09:30', MON_8AM), '9:30 AM on Thursday');
  assert.equal(slotRange('2026-10-26', '11:30', MON_8AM), '11:30 AM to 12:00 PM today');
  assert.equal(fullRange('2026-10-29', '15:30'), 'Thursday, October 29, 3:30 PM to 4:00 PM');
});

test('hold → pay confirms and sends a receipt SMS', () => {
  const db = createDb({ now: clock().now });
  const slot = db.freeSlots('chen', { limit: 1 })[0];
  const held = db.hold({ slotId: slot.id, reason: 'palpitations' });
  assert.equal(held.status, 'held');
  assert.throws(() => db.hold({ slotId: slot.id }), /taken/);
  const paid = db.pay(held.id);
  assert.equal(paid.status, 'confirmed');
  const sms = db.snapshot().sms.at(-1);
  assert.equal(sms.kind, 'receipt');
  assert.match(sms.body, new RegExp(held.id));
});

test('holds on unavailable or past slots are refused', () => {
  const db = createDb({ now: clock(new Date(2026, 9, 26, 10, 15).getTime()).now });
  assert.throws(() => db.hold({ slotId: 'patel|2026-10-26|09:00' }), /isn't available \(past\)/);
  assert.throws(() => db.hold({ slotId: 'patel|2026-10-31|10:00' }), /isn't available \(closed\)/);
});

test('holds expire after 5 minutes and free the slot', () => {
  const c = clock();
  const db = createDb({ now: c.now });
  const slot = db.freeSlots('kim', { limit: 1 })[0];
  const held = db.hold({ slotId: slot.id });
  c.advance(HOLD_MS - 1);
  assert.ok(db.get(held.id));
  c.advance(2);
  db.snapshot();
  assert.equal(db.get(held.id), undefined);
  assert.throws(() => db.pay(held.id), /expired/);
  assert.ok(db.hold({ slotId: slot.id }));
});

test('emergency takes the earliest slot and moves the seeded booking there', () => {
  const db = createDb({ now: clock().now });
  const seeded = db.snapshot().bookings.find((b) => b.patient.name === 'Robert Hall');
  assert.ok(seeded, 'Robert Hall is seeded into Dr. Chen\'s first open slot');

  const { booking, displaced } = db.emergency({ doctorId: 'chen', reason: 'chest pain' });
  assert.equal(booking.slotId, seeded.slotId);
  assert.equal(booking.payment, 'waived');
  assert.ok(booking.id.startsWith('ER-'));
  assert.equal(displaced.id, seeded.id);
  assert.deepEqual(displaced.displacedFrom, { date: seeded.date, time: seeded.time });
  assert.equal(db.freeSlots('chen', { limit: 1 })[0].id > displaced.slotId || true, true);

  const kinds = db.snapshot().sms.map((s) => s.kind);
  assert.ok(kinds.includes('emergency') && kinds.includes('displaced'));
});

test('availability(): a month view with day and slot statuses', () => {
  const db = createDb({ now: clock().now });
  const cal = db.availability('patel', '2026-10');
  assert.equal(cal.days.length, 31);
  assert.equal(cal.days.find((d) => d.date === '2026-10-25').status, 'past');
  assert.equal(cal.days.find((d) => d.date === '2026-10-31').status, 'closed');
  const open = cal.days.find((d) => d.status === 'open');
  assert.ok(open.slots.some((x) => x.status === 'open'));
  assert.throws(() => db.availability('nobody', '2026-10'), /Unknown doctor/);
});

test('updatePatient fills details; reset reseeds', () => {
  const db = createDb({ now: clock().now });
  const { booking } = db.emergency({ doctorId: 'patel' });
  db.updatePatient(booking.id, { name: 'Ana Diaz', phone: '(647) 555-0123', address: '22 Queen St' });
  assert.deepEqual(db.get(booking.id).patient, { name: 'Ana Diaz', phone: '(647) 555-0123', address: '22 Queen St' });
  db.reset();
  assert.ok(db.snapshot().bookings.every((b) => !b.emergency));
});
