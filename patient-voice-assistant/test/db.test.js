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
  assert.equal(scheduleStatus('patel', '2026-11-01'), 'closed'); // Sunday
  for (const d of ['patel', 'chen', 'lopez', 'kim', 'rahman']) {
    for (const sat of ['2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21']) assert.equal(scheduleStatus(d, sat), 'open', `${d} works Saturday ${sat}`);
  }
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
    assert.notEqual(new Date(`${s.date}T12:00`).getDay(), 0, 'no Sundays');
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
  assert.throws(() => db.hold({ slotId: 'patel|2026-11-01|10:00' }), /isn't available \(closed\)/);
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

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('emergency (Mon–Sat, specialist in today): nearest slot, pre-empting the booking there', () => {
  const db = createDb({ now: clock(at(2026, 10, 27, 8)).now }); // Tuesday 8 AM; Dr. Chen works
  const seeded = db.snapshot().bookings.find((b) => b.patient.name === 'Robert Hall');
  assert.equal(seeded.date, '2026-10-27');
  const { booking, displaced } = db.emergency({ doctorId: 'chen', reason: 'chest pain' });
  assert.equal(booking.triage, 'same-day');
  assert.equal(booking.doctorId, 'chen');
  assert.equal(booking.slotId, seeded.slotId);
  assert.equal(booking.payment, 'waived');
  assert.equal(displaced.id, seeded.id);
  assert.deepEqual(displaced.displacedFrom, { date: seeded.date, time: seeded.time });
  let kinds = db.snapshot().sms.map((x) => x.kind);
  assert.ok(kinds.includes('displaced'));
  assert.ok(!kinds.includes('emergency'), 'no confirmation text before the details are collected');
  db.updatePatient(booking.id, { name: 'Ana Diaz', address: '22 Queen St' });
  assert.ok(!db.snapshot().sms.some((x) => x.kind === 'emergency'));
  db.updatePatient(booking.id, { phone: '(647) 555-0123' });
  kinds = db.snapshot().sms.map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === 'emergency').length, 1, 'sent once, when details are complete');
  assert.equal(db.availability('chen', '2026-10').days.find((d) => d.date === '2026-10-27').slots.find((x) => x.time === booking.time).status, 'emergency');
});

test('emergency: specialist off today → a doctor who is in covers, same day', () => {
  assert.equal(scheduleStatus('chen', '2026-10-26'), 'off');
  const db = createDb({ now: clock(at(2026, 10, 26, 8)).now }); // Monday; Dr. Chen is off
  const { booking } = db.emergency({ doctorId: 'chen' });
  assert.equal(booking.triage, 'same-day');
  assert.equal(booking.date, '2026-10-26');
  assert.equal(booking.coveringFor, 'chen');
  assert.equal(booking.doctorId, 'patel');
});

test('emergency on Saturday: same-day like any working day', () => {
  const db = createDb({ now: clock(at(2026, 10, 31, 1)).now }); // Saturday 1 AM
  const { booking } = db.emergency({ doctorId: 'kim' });
  assert.equal(booking.triage, 'same-day');
  assert.equal(booking.date, '2026-10-31');
});

test('emergency on Sunday or after hours: ER advice + priority follow-up next working day', () => {
  const db = createDb({ now: clock(at(2026, 11, 1, 10)).now }); // Sunday
  const sun = db.emergency({ doctorId: 'chen', patient: { name: 'Ana', address: '1 King St', phone: '(647) 555-0123' } }).booking;
  assert.equal(sun.triage, 'er-followup');
  assert.equal(sun.closedReason, 'sunday');
  assert.equal(sun.date, '2026-11-02');
  assert.match(db.snapshot().sms.at(-1).body, /closed now\. Call 911 or go to the nearest emergency room.*follow-up/);

  const satEvening = createDb({ now: clock(at(2026, 10, 31, 17)).now }).emergency({ doctorId: 'patel' }).booking;
  assert.equal(satEvening.triage, 'er-followup');
  assert.equal(satEvening.closedReason, "today's clinic hours are over");
  assert.equal(satEvening.date, '2026-11-02'); // skips Sunday
});

test('availability(): a month view with day and slot statuses', () => {
  const db = createDb({ now: clock().now });
  const cal = db.availability('patel', '2026-10');
  assert.equal(cal.days.length, 31);
  assert.equal(cal.days.find((d) => d.date === '2026-10-25').status, 'past');
  assert.equal(cal.days.find((d) => d.date === '2026-10-31').status, 'open'); // Saturday
  assert.equal(cal.days.find((d) => d.date === '2026-10-25').status, 'past');
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

test('reschedule: moves a confirmed booking, keeps ID and payment, frees the old slot', () => {
  const db = createDb({ now: clock(at(2026, 10, 27, 8)).now });
  const [first, , third] = db.freeSlots('kim', { limit: 3 });
  const b = db.hold({ slotId: first.id });
  db.pay(b.id);
  const moved = db.reschedule(b.id, third.id);
  assert.equal(moved.id, b.id);
  assert.equal(moved.slotId, third.id);
  assert.equal(moved.payment, 'paid');
  assert.deepEqual(moved.rescheduledFrom, { date: first.date, time: first.time, doctorId: 'kim' });
  assert.ok(db.freeSlots('kim', { limit: 5 }).some((x) => x.id === first.id), 'old slot is free again');
  assert.equal(db.snapshot().sms.at(-1).kind, 'rescheduled');
  assert.throws(() => db.reschedule(b.id, third.id), /already the booked time/);
  assert.throws(() => db.reschedule(b.id, 'kim|2026-11-01|10:00'), /isn't available \(closed\)/);
  const { booking: er } = db.emergency({ doctorId: 'chen' });
  assert.throws(() => db.reschedule(er.id, db.freeSlots('chen', { limit: 1 })[0].id), /Emergency bookings/);
});
