// In-memory mock clinic: 5 doctors, a fixed two-day schedule, holds, bookings
// and an SMS log. Deterministic on purpose so the demo plays out the same way
// every time — call reset() to reseed.

export const HOLD_MS = 5 * 60 * 1000;

export const DOCTORS = [
  { id: 'patel', name: 'Dr. Sarah Patel', short: 'Dr. Patel', specialty: 'general', title: 'General Practice' },
  { id: 'chen', name: 'Dr. James Chen', short: 'Dr. Chen', specialty: 'cardiology', title: 'Cardiology' },
  { id: 'lopez', name: 'Dr. Maria Lopez', short: 'Dr. Lopez', specialty: 'dermatology', title: 'Dermatology' },
  { id: 'kim', name: 'Dr. David Kim', short: 'Dr. Kim', specialty: 'orthopedics', title: 'Orthopedics' },
  { id: 'rahman', name: 'Dr. Aisha Rahman', short: 'Dr. Rahman', specialty: 'pediatrics', title: 'Pediatrics' },
];

export const DAYS = ['today', 'tomorrow'];
export const TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30'];

// Existing normal bookings so an emergency has something to pre-empt.
const SEED = [
  { doctorId: 'patel', time: '09:00', name: 'Emily Carter', reason: 'Routine checkup' },
  { doctorId: 'patel', time: '09:30', name: 'Tom Nguyen', reason: 'Flu symptoms' },
  { doctorId: 'chen', time: '09:00', name: 'Robert Hall', reason: 'Blood pressure follow-up' },
  { doctorId: 'chen', time: '09:30', name: 'Linda Park', reason: 'ECG review' },
  { doctorId: 'chen', time: '10:30', name: 'Omar Haddad', reason: 'Palpitations follow-up' },
  { doctorId: 'lopez', time: '09:00', name: 'Grace Liu', reason: 'Skin check' },
  { doctorId: 'kim', time: '09:00', name: 'Marcus Brown', reason: 'Knee pain' },
  { doctorId: 'kim', time: '10:00', name: 'Sofia Rossi', reason: 'Back pain' },
  { doctorId: 'rahman', time: '09:30', name: 'Noah Smith', reason: 'Vaccination' },
];

export const slotId = (doctorId, day, time) => `${doctorId}|${day}|${time}`;

export function parseSlotId(id) {
  const [doctorId, day, time] = String(id).split('|');
  return { doctorId, day, time };
}

export function formatTime(time) {
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function slotLabel(day, time) {
  return `${formatTime(time)} ${day}`;
}

export const SLOT_MINUTES = 30;

// "11:00 AM to 11:30 AM today": how a booked appointment is shown and spoken.
export function slotRange(day, time) {
  const [h, m] = time.split(':').map(Number);
  const end = h * 60 + m + SLOT_MINUTES;
  const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  return `${formatTime(time)} to ${formatTime(endTime)} ${day}`;
}

function randomCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function createDb({ now = () => Date.now() } = {}) {
  let bookings = new Map(); // id -> booking
  let sms = [];
  let events = []; // dashboard activity log
  let seq = 0;

  const doctor = (id) => DOCTORS.find((d) => d.id === id);

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
    do { id = `${prefix}-${randomCode()}`; } while (bookings.has(id));
    return id;
  }

  // Drop holds whose 5-minute window has passed.
  function sweep() {
    for (const b of bookings.values()) {
      if (b.status === 'held' && b.holdExpiresAt <= now()) {
        bookings.delete(b.id);
        log('expired', `Hold ${b.id} expired — ${doctor(b.doctorId).short} ${slotLabel(b.day, b.time)} released`);
      }
    }
  }

  function bookingAt(sid) {
    for (const b of bookings.values()) if (b.slotId === sid) return b;
    return null;
  }

  function freeSlots(doctorId, { limit = Infinity } = {}) {
    sweep();
    const out = [];
    for (const day of DAYS) {
      for (const time of TIMES) {
        const sid = slotId(doctorId, day, time);
        if (!bookingAt(sid)) out.push({ id: sid, doctorId, day, time, label: slotLabel(day, time) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  function insert(fields) {
    const { doctorId, day, time } = parseSlotId(fields.slotId);
    const b = {
      patient: { name: '', phone: '', address: '' },
      reason: '',
      emergency: false,
      displaced: false,
      displacedFrom: null,
      createdAt: now(),
      ...fields,
      doctorId, day, time,
      label: slotLabel(day, time),
      range: slotRange(day, time),
    };
    bookings.set(b.id, b);
    return b;
  }

  function reset() {
    bookings = new Map();
    sms = [];
    events = [];
    for (const s of SEED) {
      insert({
        id: newId('PVA'),
        slotId: slotId(s.doctorId, 'today', s.time),
        status: 'confirmed',
        payment: 'paid',
        reason: s.reason,
        patient: { name: s.name, phone: '', address: '' },
      });
    }
    log('info', 'Clinic schedule loaded');
  }

  // Place a 5-minute hold on a free slot.
  function hold({ slotId: sid, reason = '', patient = {} }) {
    sweep();
    const { doctorId } = parseSlotId(sid);
    if (!doctor(doctorId)) throw httpError(400, `Unknown doctor in slot ${sid}`);
    if (bookingAt(sid)) throw httpError(409, 'That slot was just taken — pick another time.');
    const b = insert({
      id: newId('PVA'),
      slotId: sid,
      status: 'held',
      payment: 'pending',
      reason,
      patient: { name: '', phone: '', address: '', ...patient },
      holdExpiresAt: now() + HOLD_MS,
    });
    log('hold', `Hold ${b.id} — ${doctor(doctorId).short} ${slotLabel(b.day, b.time)} (5 min)`);
    return b;
  }

  function release(id) {
    const b = bookings.get(id);
    if (!b || b.status !== 'held') return false;
    bookings.delete(id);
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
    sendSms('patient', `Maple Clinic: Booking confirmed with ${d.name} (${d.title}), ${slotRange(b.day, b.time)}. Booking ID ${b.id}. Payment received. Reply C to cancel.`, 'receipt');
    log('confirmed', `Booking ${b.id} confirmed — ${d.short} ${slotLabel(b.day, b.time)}`);
    return b;
  }

  // Emergency: take the doctor's next same-day slot. If a normal booking
  // already sits there, move it to the doctor's next free slot.
  function emergency({ doctorId = 'patel', reason = 'Emergency', patient = {} } = {}) {
    sweep();
    if (!doctor(doctorId)) throw httpError(400, `Unknown doctor ${doctorId}`);

    let target = null;
    for (const time of TIMES) {
      const sid = slotId(doctorId, 'today', time);
      const existing = bookingAt(sid);
      if (!existing || !existing.emergency) { target = { sid, existing }; break; }
    }
    if (!target) throw httpError(409, `${doctor(doctorId).short} has no same-day capacity left.`);

    const ex = target.existing;
    if (ex) bookings.delete(ex.id);

    // Claim the slot first so the displaced booking can't land back in it.
    const b = insert({
      id: newId('ER'),
      slotId: target.sid,
      status: 'confirmed',
      payment: 'waived',
      emergency: true,
      reason,
      patient: { name: '', phone: '', address: '', ...patient },
    });
    const d = doctor(doctorId);

    let displaced = null;
    if (ex && ex.status === 'held') {
      log('released', `Hold ${ex.id} released for emergency`);
    } else if (ex) {
      const next = freeSlots(doctorId, { limit: 1 })[0];
      const fromLabel = slotLabel(ex.day, ex.time);
      if (next) {
        displaced = insert({ ...ex, slotId: next.id, displaced: true, displacedFrom: { day: ex.day, time: ex.time } });
        sendSms(ex.patient.name || 'patient', `Maple Clinic: Your ${fromLabel} appointment with ${d.short} moved to ${slotRange(next.day, next.time)} due to an emergency. Sorry for the inconvenience.`, 'displaced');
        log('displaced', `${ex.patient.name || ex.id} moved ${fromLabel} → ${next.label}`);
      } else {
        log('displaced', `${ex.patient.name || ex.id} (${fromLabel}) needs a manual reschedule — no free slots`);
      }
    }

    sendSms('patient', `Maple Clinic EMERGENCY: ${d.name} is expecting you ${slotRange(b.day, b.time).replace(/ today$/, ' TODAY')}. Booking ID ${b.id}. If symptoms worsen, call emergency services (911) immediately.`, 'emergency');
    log('emergency', `EMERGENCY ${b.id} — ${d.short} ${slotLabel(b.day, b.time)}${displaced ? ' (pre-empted a normal booking)' : ''}`);
    return { booking: b, displaced };
  }

  function updatePatient(id, patient = {}) {
    const b = bookings.get(id);
    if (!b) throw httpError(404, 'Booking not found');
    const before = { ...b.patient };
    for (const k of ['name', 'phone', 'address']) {
      if (typeof patient[k] === 'string' && patient[k].trim()) b.patient[k] = patient[k].trim();
    }
    const changed = ['name', 'phone', 'address'].filter((k) => b.patient[k] !== before[k]);
    if (changed.length) log('info', `${b.id} details updated: ${changed.join(', ')}`);
    return b;
  }

  function snapshot() {
    sweep();
    const list = [...bookings.values()].map((b) => ({
      ...b,
      doctorName: doctor(b.doctorId).name,
      label: slotLabel(b.day, b.time),
      range: slotRange(b.day, b.time),
    }));
    list.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.time.localeCompare(b.time) || a.doctorId.localeCompare(b.doctorId));
    return {
      now: now(),
      holdMs: HOLD_MS,
      doctors: DOCTORS.map((d) => ({ ...d, freeSlots: freeSlots(d.id) })),
      bookings: list,
      sms: sms.slice(-20),
      events: events.slice(-20),
    };
  }

  reset();
  return { reset, hold, release, pay, emergency, updatePatient, snapshot, freeSlots, get: (id) => bookings.get(id) };
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
