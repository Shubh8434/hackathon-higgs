// In-memory mock clinic on a real calendar: 5 doctors, Mon–Sat 9–12 and 2–4 in
// 30-minute slots, 90 days ahead of "now". Each doctor's days off and blocked
// times come from a hash of (doctor, date, time), so availability is random-
// looking but fixed — the same every run, like a hardcoded schedule. Holds,
// bookings and the SMS log live in memory; reset() reseeds demo bookings into
// each doctor's first open slots so an emergency always has one to pre-empt.

export const HOLD_MS = 5 * 60 * 1000;
export const SLOT_MINUTES = 30;
export const HORIZON_DAYS = 90; // how far ahead the calendar goes
export const SNAPSHOT_DAYS = 14; // open slots sent with every state poll
export const CLINIC_HOURS = 'Monday to Saturday, 9:00 AM to 12:00 PM and 2:00 PM to 4:00 PM (closed Sundays)';

export const DOCTORS = [
  { id: 'patel', name: 'Dr. Sarah Patel', short: 'Dr. Patel', specialty: 'general', title: 'General Practice' },
  { id: 'chen', name: 'Dr. James Chen', short: 'Dr. Chen', specialty: 'cardiology', title: 'Cardiology' },
  { id: 'lopez', name: 'Dr. Maria Lopez', short: 'Dr. Lopez', specialty: 'dermatology', title: 'Dermatology' },
  { id: 'kim', name: 'Dr. David Kim', short: 'Dr. Kim', specialty: 'orthopedics', title: 'Orthopedics' },
  { id: 'rahman', name: 'Dr. Aisha Rahman', short: 'Dr. Rahman', specialty: 'pediatrics', title: 'Pediatrics' },
];

export const TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30'];

// Demo bookings, placed at each doctor's Nth open slot (from now) on reset.
const SEED = {
  patel: [[0, 'Emily Carter', 'Routine checkup'], [1, 'Tom Nguyen', 'Flu symptoms']],
  chen: [[0, 'Robert Hall', 'Blood pressure follow-up'], [1, 'Linda Park', 'ECG review'], [3, 'Omar Haddad', 'Palpitations follow-up']],
  lopez: [[0, 'Grace Liu', 'Skin check']],
  kim: [[0, 'Marcus Brown', 'Knee pain'], [2, 'Sofia Rossi', 'Back pain']],
  rahman: [[1, 'Noah Smith', 'Vaccination']],
};

export const slotId = (doctorId, date, time) => `${doctorId}|${date}|${time}`;

export function parseSlotId(id) {
  const [doctorId, date, time] = String(id).split('|');
  return { doctorId, date, time };
}

// ---------------------------------------------------------------------------
// Dates (local time, ISO "YYYY-MM-DD") and labels
// ---------------------------------------------------------------------------
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');
const toDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const toMin = (time) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };

export function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(iso, n) {
  const d = toDate(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d.getTime());
}

const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86_400_000);

export function formatTime(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function endTime(time) {
  const end = toMin(time) + SLOT_MINUTES;
  return `${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}

// "Monday, October 26"
export function longDay(iso) {
  const d = toDate(iso);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// "today" | "tomorrow" | "Monday" (within a week) | "Tuesday, Nov 3"
export function dayWord(iso, nowMs) {
  const diff = daysBetween(isoDate(nowMs), iso);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const d = toDate(iso);
  if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()];
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

const on = (w) => (w === 'today' || w === 'tomorrow' ? w : `on ${w}`);

// "9:30 AM on Monday"
export function slotLabel(date, time, nowMs) {
  return `${formatTime(time)} ${on(dayWord(date, nowMs))}`;
}

// "11:00 AM to 11:30 AM on Monday": how an appointment is shown and spoken.
export function slotRange(date, time, nowMs) {
  return `${formatTime(time)} to ${formatTime(endTime(time))} ${on(dayWord(date, nowMs))}`;
}

// "Monday, October 26, 11:00 AM to 11:30 AM": absolute, for SMS and records.
export function fullRange(date, time) {
  return `${longDay(date)}, ${formatTime(time)} to ${formatTime(endTime(time))}`;
}

// ---------------------------------------------------------------------------
// Fixed "random" schedule: Sundays closed, every doctor works Saturdays, ~12%
// weekday days off, ~30% of slots blocked (meetings, surgery, admin). Pure
// function of its inputs, so it's the same every run.
// ---------------------------------------------------------------------------
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  // Final avalanche so neighbouring dates don't get similar values.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function scheduleStatus(doctorId, date, time = null) {
  const wd = toDate(date).getDay();
  if (wd === 0) return 'closed';
  if (wd !== 6 && hash01(`off|${doctorId}|${date}`) < 0.12) return 'off';
  if (time && hash01(`blk|${doctorId}|${date}|${time}`) < 0.3) return 'unavailable';
  return 'open';
}

function randomCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// onRecord(kind, booking, extra) is called on every booking change so a
// persistent store can keep a full record. idTaken(id) avoids reusing ids
// that already exist in that store.
// restore() returns saved upcoming bookings (see records.upcoming) to put
// back into the schedule on start and on every reset.
export function createDb({ now = () => Date.now(), onRecord = null, idTaken = () => false, restore = null } = {}) {
  let bookings = new Map(); // id -> booking
  let sms = [];
  let events = []; // dashboard activity log
  let seq = 0;

  const doctor = (id) => DOCTORS.find((d) => d.id === id);
  const record = (kind, b, extra = {}) => onRecord?.(kind, structuredClone(b), extra);
  const today = () => isoDate(now());
  const label = (b) => slotLabel(b.date, b.time, now());

  function log(kind, text) {
    events.push({ id: ++seq, kind, text, at: now() });
    if (events.length > 50) events = events.slice(-50);
  }

  function sendSms(to, body, kind = 'info') {
    const msg = { id: ++seq, to, body, kind, at: now() };
    sms.push(msg);
    if (sms.length > 50) sms = sms.slice(-50);
    return msg;
  }

  function newId(prefix) {
    let id;
    do { id = `${prefix}-${randomCode()}`; } while (bookings.has(id) || idTaken(id));
    return id;
  }

  // Drop holds whose 5-minute window has passed.
  function sweep() {
    for (const b of bookings.values()) {
      if (b.status === 'held' && b.holdExpiresAt <= now()) {
        bookings.delete(b.id);
        record('expired', b);
        log('expired', `Hold ${b.id} expired — ${doctor(b.doctorId).short} ${label(b)} released`);
      }
    }
  }

  function bookingAt(sid) {
    for (const b of bookings.values()) if (b.slotId === sid) return b;
    return null;
  }

  function isPast(date, time) {
    const t = today();
    if (date !== t) return date < t;
    const d = new Date(now());
    return toMin(time) <= d.getHours() * 60 + d.getMinutes();
  }

  // past | closed | off | unavailable | held | booked | open
  function slotStatus(doctorId, date, time) {
    if (isPast(date, time)) return 'past';
    const base = scheduleStatus(doctorId, date, time);
    if (base !== 'open') return base;
    const b = bookingAt(slotId(doctorId, date, time));
    if (b) return b.emergency ? 'emergency' : b.status === 'held' ? 'held' : 'booked';
    return 'open';
  }

  function* upcoming(days = HORIZON_DAYS) {
    const start = today();
    for (let i = 0; i <= days; i++) {
      const date = addDays(start, i);
      for (const time of TIMES) yield { date, time };
    }
  }

  const slotOf = (doctorId, date, time) => ({
    id: slotId(doctorId, date, time), doctorId, date, time,
    label: slotLabel(date, time, now()), range: slotRange(date, time, now()), dayLabel: dayWord(date, now()),
  });

  // Open slots from now, soonest first.
  function freeSlots(doctorId, { limit = Infinity, days = HORIZON_DAYS } = {}) {
    sweep();
    const out = [];
    for (const { date, time } of upcoming(days)) {
      if (slotStatus(doctorId, date, time) === 'open') out.push(slotOf(doctorId, date, time));
      if (out.length >= limit) break;
    }
    return out;
  }

  // Month view for the availability calendar. month = "YYYY-MM".
  function availability(doctorId, month) {
    sweep();
    if (!doctor(doctorId)) throw httpError(404, `Unknown doctor ${doctorId}`);
    if (!/^\d{4}-\d{2}$/.test(String(month))) throw httpError(400, 'month must be YYYY-MM');
    const t = today();
    const last = addDays(t, HORIZON_DAYS);
    const days = [];
    for (let date = `${month}-01`; date.startsWith(month); date = addDays(date, 1)) {
      const base = scheduleStatus(doctorId, date);
      if (date < t) { days.push({ date, status: 'past', open: 0, slots: [] }); continue; }
      if (date > last) { days.push({ date, status: 'beyond', open: 0, slots: [] }); continue; }
      if (base !== 'open') { days.push({ date, status: base, open: 0, slots: [] }); continue; }
      const slots = TIMES.map((time) => ({ id: slotId(doctorId, date, time), time, label: formatTime(time), status: slotStatus(doctorId, date, time) }));
      const open = slots.filter((x) => x.status === 'open').length;
      days.push({ date, status: open ? 'open' : 'full', open, dayLabel: dayWord(date, now()), slots });
    }
    return { doctorId, month, today: t, horizon: last, days };
  }

  function insert(fields) {
    const { doctorId, date, time } = parseSlotId(fields.slotId);
    const b = {
      patient: { name: '', phone: '', address: '' },
      reason: '',
      emergency: false,
      displaced: false,
      displacedFrom: null,
      createdAt: now(),
      ...fields,
      doctorId, date, time,
      label: slotLabel(date, time, now()),
      range: slotRange(date, time, now()),
    };
    bookings.set(b.id, b);
    return b;
  }

  function reset() {
    bookings = new Map();
    sms = [];
    events = [];
    // Real bookings first (newest wins a slot clash), then demo bookings
    // fill each doctor's first open slots around them.
    let restored = 0;
    for (const r of restore?.(now()) || []) {
      if (!doctor(r.doctorId) || bookings.has(r.id)) continue;
      const sid = slotId(r.doctorId, r.date, r.time);
      if (bookingAt(sid)) continue;
      const { doctorId: _d, date: _a, time: _t, ...rest } = r;
      insert({ ...rest, slotId: sid, status: 'confirmed', displaced: false, displacedFrom: null });
      restored++;
    }
    for (const [doctorId, seeds] of Object.entries(SEED)) {
      const open = freeSlots(doctorId, { limit: 6 });
      for (const [pos, name, reason] of seeds) {
        if (!open[pos]) continue;
        insert({ id: newId('PVA'), slotId: open[pos].id, status: 'confirmed', payment: 'paid', reason, patient: { name, phone: '', address: '' } });
      }
    }
    log('info', `Clinic schedule loaded${restored ? ` (${restored} saved booking${restored === 1 ? '' : 's'} restored)` : ''}`);
  }

  // Place a 5-minute hold on an open slot.
  function hold({ slotId: sid, reason = '', patient = {}, meta = {} }) {
    sweep();
    const { doctorId, date, time } = parseSlotId(sid);
    if (!doctor(doctorId)) throw httpError(400, `Unknown doctor in slot ${sid}`);
    const st = slotStatus(doctorId, date, time);
    if (st === 'booked' || st === 'held' || st === 'emergency') throw httpError(409, 'That slot was just taken — pick another time.');
    if (st !== 'open') throw httpError(409, `That time isn't available (${st}) — pick another time.`);
    const b = insert({
      id: newId('PVA'),
      slotId: sid,
      status: 'held',
      payment: 'pending',
      reason,
      patient: { name: '', phone: '', address: '', ...patient },
      holdExpiresAt: now() + HOLD_MS,
      meta,
    });
    record('held', b);
    log('hold', `Hold ${b.id} — ${doctor(doctorId).short} ${label(b)} (5 min)`);
    return b;
  }

  function release(id) {
    const b = bookings.get(id);
    if (!b || b.status !== 'held') return false;
    bookings.delete(id);
    record('released', b);
    log('released', `Hold ${id} released`);
    return true;
  }

  // Mock payment "Done" button: confirm the hold and text a receipt.
  function pay(id) {
    sweep();
    const b = bookings.get(id);
    if (!b) throw httpError(404, 'Hold not found or expired — please pick the time again.');
    if (b.status === 'confirmed') return b;
    if (b.status !== 'held') throw httpError(409, `Booking ${id} cannot be paid (status ${b.status}).`);
    b.status = 'confirmed';
    b.payment = 'paid';
    delete b.holdExpiresAt;
    const d = doctor(b.doctorId);
    const receipt = sendSms('patient', `Maple Clinic: Booking confirmed with ${d.name} (${d.title}), ${fullRange(b.date, b.time)}. Booking ID ${b.id}. Payment received. Reply C to cancel.`, 'receipt');
    record('confirmed', b, { sms: receipt.body });
    log('confirmed', `Booking ${b.id} confirmed — ${d.short} ${label(b)}`);
    return b;
  }

  // Earliest slot a doctor can give an emergency: their nearest working slot
  // from now, even if a normal booking sits there (it gets moved).
  function emergencySlot(doctorId) {
    for (const { date, time } of upcoming()) {
      if (isPast(date, time) || scheduleStatus(doctorId, date, time) !== 'open') continue;
      const existing = bookingAt(slotId(doctorId, date, time));
      if (!existing || !existing.emergency) return { date, time, sid: slotId(doctorId, date, time), existing };
    }
    return null;
  }

  // Emergency triage:
  //  same-day   — a slot is left today (Mon–Sat): the specialist if they're in
  //               today, else whoever is (GP first). Pre-empts a booking if needed.
  //  er-followup — clinic closed now (Sunday, or today's hours are over): the
  //               patient is told to call 911 / go to the ER, and gets a
  //               priority follow-up at the next working slot.
  function emergency({ doctorId = 'patel', reason = 'Emergency', patient = {}, meta = {} } = {}) {
    sweep();
    if (!doctor(doctorId)) throw httpError(400, `Unknown doctor ${doctorId}`);
    const t = today();
    const sunday = toDate(t).getDay() === 0;

    let chosen = doctorId;
    let target = emergencySlot(doctorId);
    let coveringFor = null;
    if (!target || target.date !== t) {
      // Specialist isn't in today: whoever is, GP first.
      for (const id of ['patel', ...DOCTORS.map((d) => d.id)].filter((id, i, a) => id !== doctorId && a.indexOf(id) === i)) {
        const alt = emergencySlot(id);
        if (alt && alt.date === t) { chosen = id; target = alt; coveringFor = doctorId; break; }
      }
    }
    if (!target) throw httpError(409, 'No emergency capacity left on the calendar.');
    const triage = target.date === t ? 'same-day' : 'er-followup';
    const closedReason = triage === 'same-day' ? null : sunday ? 'sunday' : "today's clinic hours are over";

    const ex = target.existing;
    if (ex) bookings.delete(ex.id);

    // Claim the slot first so the displaced booking can't land back in it.
    const b = insert({
      id: newId('ER'),
      slotId: target.sid,
      status: 'confirmed',
      payment: 'waived',
      emergency: true,
      triage,
      closedReason,
      coveringFor,
      reason,
      patient: { name: '', phone: '', address: '', ...patient },
      meta,
    });
    const d = doctor(chosen);

    let displaced = null;
    if (ex && ex.status === 'held') {
      record('released', ex, { reason: 'Slot taken by an emergency' });
      log('released', `Hold ${ex.id} released for emergency`);
    } else if (ex) {
      const next = freeSlots(chosen, { limit: 1 })[0];
      const fromLabel = label(ex);
      if (next) {
        displaced = insert({ ...ex, slotId: next.id, displaced: true, displacedFrom: { date: ex.date, time: ex.time } });
        record('moved', displaced, { from: fullRange(ex.date, ex.time), to: fullRange(next.date, next.time), reason: `Pre-empted by emergency ${b.id}` });
        sendSms(ex.patient.name || 'patient', `Maple Clinic: Your ${fromLabel} appointment with ${d.short} moved to ${fullRange(next.date, next.time)} due to an emergency. Sorry for the inconvenience.`, 'displaced');
        log('displaced', `${ex.patient.name || ex.id} moved ${fromLabel} → ${next.label}`);
      } else {
        log('displaced', `${ex.patient.name || ex.id} (${fromLabel}) needs a manual reschedule — no free slots`);
      }
    }

    const body = triage === 'same-day'
      ? `Maple Clinic EMERGENCY: ${d.name} is expecting you ${fullRange(b.date, b.time)} (priority slot). Booking ID ${b.id}. If symptoms worsen, call 911 immediately.`
      : `Maple Clinic EMERGENCY: The clinic is closed now. Call 911 or go to the nearest emergency room immediately. Priority follow-up booked with ${d.name}, ${fullRange(b.date, b.time)}. Booking ID ${b.id}.`;
    // The confirmation text goes out once Ava has the patient's name, address
    // and phone (the moment she confirms the booking), not before.
    b.pendingSms = body;
    const alert = detailsComplete(b) ? flushEmergencySms(b) : null;
    record('emergency', b, {
      sms: alert?.body,
      triage, closedReason, coveringFor,
      displaced: displaced ? { bookingId: displaced.id, patient: displaced.patient.name, from: fullRange(displaced.displacedFrom.date, displaced.displacedFrom.time), to: fullRange(displaced.date, displaced.time) } : null,
    });
    log('emergency', `EMERGENCY ${b.id} — ${d.short} ${label(b)} · ${triage === 'same-day' ? 'same-day priority' : 'ER advised + follow-up'}${coveringFor ? ` (covering for ${doctor(coveringFor).short})` : ''}${displaced ? ' (pre-empted a normal booking)' : ''}`);
    return { booking: b, displaced };
  }

  // Move a confirmed (paid) booking to another open slot. Same booking ID,
  // payment carries over. Emergency bookings aren't moved this way.
  function reschedule(id, sid) {
    sweep();
    const b = bookings.get(id);
    if (!b) throw httpError(404, `Booking ${id} not found.`);
    if (b.emergency) throw httpError(409, 'Emergency bookings can\'t be moved here. Please call the clinic.');
    if (b.status !== 'confirmed') throw httpError(409, `Booking ${id} isn't confirmed yet, so there's nothing to reschedule.`);
    const { doctorId, date, time } = parseSlotId(sid);
    if (!doctor(doctorId)) throw httpError(400, `Unknown doctor in slot ${sid}`);
    if (sid === b.slotId) throw httpError(409, 'That is already the booked time.');
    const st = slotStatus(doctorId, date, time);
    if (st !== 'open') throw httpError(409, `That time isn't available (${st}). Please pick another.`);

    const from = { date: b.date, time: b.time, doctorId: b.doctorId };
    const fromLabel = `${doctor(b.doctorId).short} ${label(b)}`;
    bookings.delete(id);
    const moved = insert({ ...b, slotId: sid, displaced: false, displacedFrom: null, rescheduledFrom: from });
    const d = doctor(doctorId);
    const sms = sendSms('patient', `Maple Clinic: Your appointment ${b.id} has been rescheduled to ${fullRange(moved.date, moved.time)} with ${d.name}. Was: ${fullRange(from.date, from.time)}. Reply C to cancel.`, 'rescheduled');
    record('rescheduled', moved, { from: fullRange(from.date, from.time), fromDoctor: doctor(from.doctorId).name, to: fullRange(moved.date, moved.time), sms: sms.body });
    log('rescheduled', `${b.id} rescheduled — ${fromLabel} → ${d.short} ${label(moved)}`);
    return moved;
  }

  const detailsComplete = (b) => ['name', 'address', 'phone'].every((k) => b.patient?.[k]);

  function flushEmergencySms(b) {
    const msg = sendSms('patient', b.pendingSms, 'emergency');
    delete b.pendingSms;
    return msg;
  }

  function updatePatient(id, patient = {}) {
    const b = bookings.get(id);
    if (!b) throw httpError(404, 'Booking not found');
    const before = { ...b.patient };
    for (const k of ['name', 'phone', 'address']) {
      if (typeof patient[k] === 'string' && patient[k].trim()) b.patient[k] = patient[k].trim();
    }
    const changed = ['name', 'phone', 'address'].filter((k) => b.patient[k] !== before[k]);
    // Saved to the bookings database only; too noisy for the dashboard log.
    if (changed.length) {
      const sms = b.pendingSms && detailsComplete(b) ? flushEmergencySms(b) : null;
      record('details', b, { changed, sms: sms?.body });
    }
    return b;
  }

  function snapshot() {
    sweep();
    const t = today();
    const list = [...bookings.values()]
      .filter((b) => b.date >= t)
      .map((b) => ({
        ...b,
        doctorName: doctor(b.doctorId).name,
        label: slotLabel(b.date, b.time, now()),
        range: slotRange(b.date, b.time, now()),
        dayLabel: dayWord(b.date, now()),
      }));
    list.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.doctorId.localeCompare(b.doctorId));
    return {
      now: now(),
      today: t,
      clinicHours: CLINIC_HOURS,
      holdMs: HOLD_MS,
      doctors: DOCTORS.map((d) => ({ ...d, freeSlots: freeSlots(d.id, { days: SNAPSHOT_DAYS }) })),
      bookings: list,
      sms: sms.slice(-20),
      events: events.slice(-20),
    };
  }

  reset();
  return { reset, hold, release, pay, emergency, reschedule, updatePatient, snapshot, freeSlots, availability, get: (id) => bookings.get(id) };
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
