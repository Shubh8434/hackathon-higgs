// Permanent bookings database: data/bookings.json. Every booking made through
// the chat (normal or emergency) gets a record holding everything we learned:
// patient details, problem, specialty, doctor, real calendar date and time
// range, payment, emergency alert, SMS sent, linked conversation, and a full
// history of status changes. Survives "Reset demo" and server restarts.
// Seeded demo bookings are never recorded.

import fs from 'node:fs';
import path from 'node:path';
import { DOCTORS, formatTime, slotRange, SLOT_MINUTES } from './db.js';

const STATUS = { held: 'held', released: 'released', expired: 'expired', confirmed: 'confirmed', emergency: 'confirmed' };

function isoDate(ms, dayOffset) {
  const d = new Date(ms);
  d.setDate(d.getDate() + dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function endTime(time) {
  const [h, m] = time.split(':').map(Number);
  const end = h * 60 + m + SLOT_MINUTES;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

function slotOf(b, createdAt) {
  return {
    day: b.day,
    date: isoDate(createdAt, b.day === 'tomorrow' ? 1 : 0),
    start: formatTime(b.time),
    end: formatTime(endTime(b.time)),
    range: slotRange(b.day, b.time),
  };
}

export function createBookingRecords({ file, now = () => Date.now() }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let records = {};
  try { records = JSON.parse(fs.readFileSync(file, 'utf8')).bookings || {}; } catch {}

  function persist() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ bookings: records }, null, 2));
    fs.renameSync(tmp, file);
  }

  // Called by the clinic DB on every booking change.
  function apply(kind, b, extra = {}) {
    let r = records[b.id];
    if (!r) {
      if (kind !== 'held' && kind !== 'emergency') return; // seeded demo bookings
      const doc = DOCTORS.find((d) => d.id === b.doctorId);
      const meta = b.meta || {};
      r = records[b.id] = {
        id: b.id,
        type: b.emergency ? 'emergency' : 'normal',
        status: STATUS[kind],
        conversationId: meta.conversationId || null,
        patient: { name: '', address: '', phone: '' },
        problem: b.reason || '',
        specialty: meta.specialty || doc?.specialty || null,
        doctorChosenBy: meta.doctorSource || (b.emergency ? 'emergency routing' : null),
        doctor: { id: doc.id, name: doc.name, title: doc.title },
        slot: slotOf(b, now()),
        payment: { status: b.payment, amount: 0 },
        emergency: b.emergency ? { detectedBy: meta.alertSource || null, phrase: meta.alertPhrase || '', preempted: null } : null,
        sms: [],
        createdAt: now(),
        updatedAt: now(),
        confirmedAt: null,
        history: [],
      };
    }

    r.patient = { name: b.patient?.name || r.patient.name, address: b.patient?.address || r.patient.address, phone: b.patient?.phone || r.patient.phone };
    if (STATUS[kind]) r.status = STATUS[kind];
    r.payment = { status: b.payment, amount: b.payment === 'paid' ? 40 : 0 };
    if (kind === 'moved') r.slot = slotOf(b, now());
    if (kind === 'confirmed' || kind === 'emergency') r.confirmedAt = now();
    if (extra.sms) r.sms.push({ at: now(), body: extra.sms });
    if (kind === 'emergency' && extra.displaced) r.emergency.preempted = extra.displaced;

    const detail = {
      held: `Held ${r.slot.range} with ${r.doctor.name}`,
      released: extra.reason || 'Hold released',
      expired: 'Hold expired before payment',
      confirmed: 'Paid $40 copay, booking confirmed',
      emergency: `Emergency slot ${r.slot.range} with ${r.doctor.name}${extra.displaced ? `; moved ${extra.displaced.patient || extra.displaced.bookingId} to ${extra.displaced.to}` : ''}`,
      moved: `Moved from ${extra.from} to ${extra.to}${extra.reason ? ` (${extra.reason})` : ''}`,
      details: `Updated ${(extra.changed || []).join(', ')}`,
    }[kind] || kind;
    r.history.push({ at: now(), event: kind, detail });
    r.updatedAt = now();
    persist();
  }

  const list = () => Object.values(records).sort((a, b) => b.createdAt - a.createdAt);
  const get = (id) => records[id] || null;
  const has = (id) => Boolean(records[id]);

  return { apply, list, get, has };
}
