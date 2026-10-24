// Permanent bookings database: data/bookings.json. Every booking made through
// the chat (normal or emergency) gets a record holding everything we learned:
// patient details, problem, specialty, doctor, real calendar date and time
// range, payment, emergency alert, SMS sent, linked conversation, and a full
// history of status changes. Survives "Reset demo" and server restarts.
// Seeded demo bookings are never recorded.

import fs from 'node:fs';
import path from 'node:path';
import { DOCTORS, formatTime, endTime, fullRange, dayWord } from './db.js';

const STATUS = { held: 'held', released: 'released', expired: 'expired', confirmed: 'confirmed', emergency: 'confirmed' };

function slotOf(b, at) {
  return {
    date: b.date,
    time: b.time, // "HH:MM", used to restore the booking into the live schedule
    day: dayWord(b.date, at),
    start: formatTime(b.time),
    end: formatTime(endTime(b.time)),
    range: fullRange(b.date, b.time),
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

  // Holds only live in server memory, so any still "held" at startup were
  // lost when the server stopped: record them as expired.
  let stale = 0;
  for (const r of Object.values(records)) {
    if (r.status !== 'held') continue;
    r.status = 'expired';
    r.history.push({ at: now(), event: 'expired', detail: 'Hold lost when the server restarted (never paid)' });
    r.updatedAt = now();
    stale++;
  }
  if (stale) persist();

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
        emergency: b.emergency ? {
          detectedBy: meta.alertSource || null,
          phrase: meta.alertPhrase || '',
          triage: b.triage || null, // 'same-day' | 'er-followup'
          advice: b.triage === 'er-followup' ? 'Clinic closed: told to call 911 / go to the ER; priority follow-up booked' : 'Same-day priority slot',
          closedReason: b.closedReason || null,
          coveringFor: b.coveringFor || null,
          preempted: null,
        } : null,
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
    if (kind === 'moved' || kind === 'rescheduled') r.slot = slotOf(b, now());
    if (kind === 'rescheduled') {
      const doc = DOCTORS.find((d) => d.id === b.doctorId);
      r.doctor = { id: doc.id, name: doc.name, title: doc.title };
      (r.reschedules ||= []).push({ at: now(), from: extra.from, fromDoctor: extra.fromDoctor, to: extra.to });
    }
    if (kind === 'confirmed' || kind === 'emergency') r.confirmedAt = now();
    if (extra.sms) r.sms.push({ at: now(), body: extra.sms });
    if (kind === 'emergency' && extra.displaced) r.emergency.preempted = extra.displaced;

    const detail = {
      held: `Held ${r.slot.range} with ${r.doctor.name}`,
      released: extra.reason || 'Hold released',
      expired: 'Hold expired before payment',
      confirmed: 'Paid $40 copay, booking confirmed',
      emergency: `${b.triage === 'er-followup' ? 'ER advised; priority follow-up' : 'Same-day emergency slot'} ${r.slot.range} with ${r.doctor.name}${extra.displaced ? `; moved ${extra.displaced.patient || extra.displaced.bookingId} to ${extra.displaced.to}` : ''}`,
      moved: `Moved from ${extra.from} to ${extra.to}${extra.reason ? ` (${extra.reason})` : ''}`,
      rescheduled: `Rescheduled by patient from ${extra.from}${extra.fromDoctor !== r.doctor.name ? ` (${extra.fromDoctor})` : ''} to ${extra.to} with ${r.doctor.name}`,
      details: `Updated ${(extra.changed || []).join(', ')}`,
    }[kind] || kind;
    r.history.push({ at: now(), event: kind, detail });
    r.updatedAt = now();
    persist();
  }

  const list = () => Object.values(records).sort((a, b) => b.createdAt - a.createdAt);

  // Confirmed bookings that haven't happened yet, newest first, in the shape
  // the clinic schedule needs. Lets reset/restart keep real bookings.
  function upcoming(nowMs = now()) {
    const today = new Date(nowMs);
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const nowMin = today.getHours() * 60 + today.getMinutes();
    const to24 = (start) => {
      const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(start || '');
      if (!m) return null;
      const h = (Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0);
      return `${String(h).padStart(2, '0')}:${m[2]}`;
    };
    return Object.values(records)
      .filter((r) => r.status === 'confirmed')
      .map((r) => ({ r, time: r.slot.time || to24(r.slot.start) }))
      .filter(({ r, time }) => time && (r.slot.date > todayIso || (r.slot.date === todayIso && Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) > nowMin)))
      .sort((a, b) => (b.r.confirmedAt || b.r.updatedAt) - (a.r.confirmedAt || a.r.updatedAt))
      .map(({ r, time }) => ({
        id: r.id,
        doctorId: r.doctor.id,
        date: r.slot.date,
        time,
        payment: r.payment.status,
        emergency: r.type === 'emergency',
        triage: r.emergency?.triage || undefined,
        coveringFor: r.emergency?.coveringFor || undefined,
        closedReason: r.emergency?.closedReason || undefined,
        reason: r.problem,
        patient: { ...r.patient },
        meta: r.conversationId ? { conversationId: r.conversationId } : {},
        createdAt: r.createdAt,
      }));
  }
  const get = (id) => records[id] || null;
  const has = (id) => Boolean(records[id]);

  return { apply, list, get, has, upcoming };
}
