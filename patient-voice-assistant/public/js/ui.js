// DOM helpers + pure render functions (state in → DOM out).

import { highlightSegments } from './keywords.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}

function formatTime(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// "Thursday, October 29, 3:30 PM to 4:00 PM"
function fullRange(b) {
  if (!b?.date || !b.time) return b?.range || b?.label || '';
  const [h, m] = b.time.split(':').map(Number);
  const end = h * 60 + m + 30;
  const day = new Date(`${b.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return `${day}, ${formatTime(b.time)} to ${formatTime(`${Math.floor(end / 60)}:${end % 60}`)}`;
}

const shortDate = (b) => (b?.date ? new Date(`${b.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '');

// ---------------------------------------------------------------------------
// Captions with keyword highlighting
// ---------------------------------------------------------------------------
export function setHighlighted(node, text) {
  node.textContent = '';
  for (const seg of highlightSegments(text)) {
    node.append(seg.cls ? el('mark', { className: seg.cls, textContent: seg.text }) : document.createTextNode(seg.text));
  }
}

export function addBubble(role, text = '', { pending = false, badge = '' } = {}) {
  const box = $('#captions');
  $('#captionsEmpty')?.remove();
  const bubble = el('div', { className: `bubble ${role}${pending ? ' pending' : ''}` });
  bubble.dataset.raw = text;
  const who = el('div', { className: 'who', textContent: role === 'user' ? 'Patient' : 'Ava' });
  if (badge) who.append(el('span', { className: 'badge', textContent: badge }));
  const body = el('div', { className: 'body' });
  setHighlighted(body, text || '…');
  bubble.append(who, body);
  box.append(bubble);
  box.scrollTop = box.scrollHeight;
  return bubble;
}

export function updateBubble(bubble, text, { pending } = {}) {
  if (!bubble) return;
  bubble.dataset.raw = text;
  setHighlighted($('.body', bubble), text || '…');
  if (pending === false) bubble.classList.remove('pending');
  const box = $('#captions');
  box.scrollTop = box.scrollHeight;
}

export function clearCaptions() {
  $('#captions').innerHTML = '<div class="muted empty" id="captionsEmpty">Captions appear here. Start a voice session or tap a demo phrase.</div>';
}

// ---------------------------------------------------------------------------
// Character + 4 cards
// ---------------------------------------------------------------------------
const STATE_LABEL = { idle: 'Idle', listening: 'Listening…', speaking: 'Speaking…', alert: 'EMERGENCY' };

export function renderCharacter(state) {
  const c = $('#character');
  if (c.dataset.state === state) return;
  c.dataset.state = state;
  $('#charState').textContent = STATE_LABEL[state];
  $('#charState').dataset.state = state;
}

function card(id, value, sub = '', cls = '') {
  const node = $(id);
  $('.value', node).textContent = value || '—';
  $('.sub', node).textContent = sub;
  node.className = `info-card ${cls}`.trim();
}

export function renderCards(s, doctor, holdRemainingMs) {
  const booking = s.mode === 'emergency' ? s.emergency : s.hold || s.confirmed;
  const docId = booking?.doctorId || s.doctorId;
  const d = docId ? doctor(docId) : null;
  card('#cardDoctor', d?.name, d ? `${d.title}${!booking && s.doctorSource === 'symptom' ? ' · recommended' : ''}` : 'Describe your problem', d ? 'filled' : '');

  let time = '';
  let timeSub = '';
  if (booking) {
    time = booking.range || booking.label;
    const status = booking.emergency ? 'Earliest emergency slot' : s.hold ? `On hold · ${fmtCountdown(holdRemainingMs)}` : 'Confirmed';
    timeSub = [shortDate(booking), status].filter(Boolean).join(' · ');
  }
  else if (s.proposedSlotId && s.proposedLabel) {
    time = s.proposedLabel;
    timeSub = 'Proposed — say “yes” to hold';
  }
  card('#cardTime', time, timeSub, booking?.emergency ? 'filled danger' : time ? 'filled' : '');

  let tag = '';
  if (booking?.emergency) tag = 'EMERGENCY';
  else if (s.hold) tag = 'HELD';
  else if (s.confirmed) tag = 'CONFIRMED';
  card('#cardBooking', booking?.id, tag, booking?.emergency ? 'filled danger' : booking ? 'filled' : '');

  const pay = booking?.payment;
  const payText = { pending: 'Awaiting payment', paid: 'Paid ✓', waived: 'Waived' }[pay] || '';
  const pendingSub = FIELDS.includes(s.awaiting) ? 'Collecting your details first' : s.awaiting === 'confirm' ? 'Confirm your details first' : 'Tap Done on payment screen';
  const paySub = { pending: pendingSub, paid: '$40 copay received', waived: 'Emergency — no charge' }[pay] || '';
  card('#cardPayment', payText, paySub, pay === 'paid' ? 'filled good' : pay === 'waived' ? 'filled danger' : pay ? 'filled warn' : '');
}

export function fmtCountdown(ms) {
  if (ms == null) return '';
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Doctors menu + slots
// ---------------------------------------------------------------------------
export function renderDoctors(snapshot, s, { onDoctor, onSlot }) {
  const list = $('#doctorList');
  list.innerHTML = '';
  const disabled = s.mode === 'emergency' || Boolean(s.confirmed);
  const recommended = s.specialty ? { general: 'patel', cardiology: 'chen', dermatology: 'lopez', orthopedics: 'kim', pediatrics: 'rahman' }[s.specialty] : null;
  for (const d of snapshot.doctors) {
    const btn = el('button', {
      className: `doctor${d.id === s.doctorId ? ' selected' : ''}${d.id === recommended ? ' recommended' : ''}`,
      type: 'button',
      disabled,
      onclick: () => onDoctor(d.id),
    });
    btn.append(
      el('div', { className: 'avatar-dot', textContent: d.name.split(' ').at(-1)[0] }),
      el('div', { className: 'doc-text' },
        el('div', { className: 'doc-name', textContent: d.name }),
        el('div', { className: 'doc-title', textContent: d.title })),
    );
    if (d.id === recommended) btn.append(el('span', { className: 'pill', textContent: 'match' }));
    list.append(btn);
  }

  const slots = $('#slotList');
  slots.innerHTML = '';
  const d = snapshot.doctors.find((x) => x.id === s.doctorId);
  $('#slotHeading').textContent = d ? `Open times · ${d.short}` : 'Open times';
  if (!d) {
    slots.append(el('div', { className: 'muted small', textContent: 'Pick a doctor (or describe your problem) to see times.' }));
    return;
  }
  const items = [...d.freeSlots];
  if (s.hold && s.hold.doctorId === d.id) items.unshift({ id: s.hold.slotId, label: s.hold.label, held: true });
  for (const slot of items.slice(0, 6)) {
    slots.append(el('button', {
      className: `slot${slot.held ? ' held' : ''}${slot.id === s.proposedSlotId ? ' proposed' : ''}`,
      type: 'button',
      disabled: disabled || slot.held,
      textContent: slot.held ? `${slot.label} · held` : slot.label,
      onclick: () => onSlot(slot.id),
    }));
  }
}

// ---------------------------------------------------------------------------
// Clinic dashboard (schedule) — animates new / moved rows
// ---------------------------------------------------------------------------
const seenRows = new Map(); // booking id -> slotId
let scheduleSig = '';

export function renderSchedule(snapshot, doctor) {
  // Only rebuild when something changed, so row animations aren't restarted.
  const sig = JSON.stringify([snapshot.bookings.map((b) => [b.id, b.slotId, b.status, b.patient.name]), snapshot.events.at(-1)?.id]);
  if (sig === scheduleSig) return;
  scheduleSig = sig;
  const body = $('#scheduleBody');
  body.innerHTML = '';
  let lastDay = null;
  for (const b of snapshot.bookings) {
    if ((b.date || b.day) !== lastDay) {
      const word = b.dayLabel || b.day || '';
      const nice = b.date ? new Date(`${b.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : word;
      body.append(el('tr', { className: 'day-row' }, el('td', { colSpan: 4, textContent: /^(today|tomorrow)$/.test(word) ? `${word[0].toUpperCase()}${word.slice(1)} · ${nice}` : nice })));
      lastDay = b.date || b.day;
    }
    let tag = b.status === 'held' ? 'HELD' : 'CONFIRMED';
    let cls = b.status === 'held' ? 'tag-held' : 'tag-ok';
    if (b.emergency) { tag = 'EMERGENCY'; cls = 'tag-emergency'; }
    else if (b.displaced) { tag = `MOVED from ${formatTime(b.displacedFrom.time)}`; cls = 'tag-displaced'; }

    const prev = seenRows.get(b.id);
    let anim = '';
    if (seenRows.size && prev === undefined) anim = b.emergency ? 'row-emergency-in' : 'row-in';
    else if (prev !== undefined && prev !== b.slotId) anim = 'row-displaced-in';

    const tr = el('tr', { className: `${b.emergency ? 'emergency' : ''} ${b.displaced ? 'displaced' : ''} ${anim}`.trim() },
      el('td', { className: 'time', textContent: formatTime(b.time) }),
      el('td', { textContent: doctor(b.doctorId)?.short || b.doctorId }),
      el('td', { textContent: b.patient.name || (b.emergency ? 'Caller (details pending)' : 'Caller') }),
      el('td', {}, el('span', { className: `tag ${cls}`, textContent: tag })),
    );
    body.append(tr);
  }
  seenRows.clear();
  for (const b of snapshot.bookings) seenRows.set(b.id, b.slotId);
  if (!seenRows.size) seenRows.set('__init__', '');

  const log = $('#eventLog');
  log.innerHTML = '';
  for (const e of snapshot.events.slice(-6).reverse()) {
    log.append(el('li', { className: `ev ev-${e.kind}` },
      el('span', { className: 'muted', textContent: new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' }),
      e.text));
  }
}

// ---------------------------------------------------------------------------
// Virtual phone: 2-3 most recent SMS to the caller
// ---------------------------------------------------------------------------
let lastSmsId = 0;
export function renderPhone(snapshot) {
  const msgs = snapshot.sms.filter((m) => m.to === 'patient').slice(-3);
  const list = $('#smsList');
  const newest = msgs.at(-1)?.id || 0;
  if (newest === lastSmsId && list.childElementCount) return;
  list.innerHTML = '';
  if (!msgs.length) list.append(el('div', { className: 'sms-empty', textContent: 'No messages yet' }));
  for (const m of msgs) {
    list.append(el('div', { className: `sms sms-${m.kind}${m.id > lastSmsId && lastSmsId ? ' sms-new' : ''}` },
      el('div', { className: 'sms-body', textContent: m.body }),
      el('div', { className: 'sms-time', textContent: new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })));
  }
  if (newest > lastSmsId && lastSmsId) {
    $('#phone').classList.remove('buzz');
    void $('#phone').offsetWidth;
    $('#phone').classList.add('buzz');
  }
  lastSmsId = newest;
  $('#phoneBadge').textContent = msgs.length ? String(snapshot.sms.filter((m) => m.to === 'patient').length) : '';
}

export function resetRenderMemory() {
  seenRows.clear();
  scheduleSig = '';
  lastSmsId = 0;
}

// ---------------------------------------------------------------------------
// Emergency banner + details form
// ---------------------------------------------------------------------------
const SOURCE_LABEL = {
  'safety-net': 'STT safety net (keyword)',
  model: 'Assistant (model)',
  manual: 'Manual trigger',
};

export function renderEmergency(s, doctor) {
  const banner = $('#emergencyBanner');
  const on = s.mode === 'emergency';
  banner.classList.toggle('hidden', !on);
  document.body.classList.toggle('is-emergency', on);
  if (!on) return;
  $('#alertSource').textContent = `${SOURCE_LABEL[s.alert?.source] || ''}${s.alert?.phrase && s.alert.source !== 'manual' ? ` · “${s.alert.phrase}”` : ''}`;
  const b = s.emergency;
  $('#alertSlot').textContent = b
    ? `${b.triage === 'er-followup' ? 'Follow-up: ' : ''}${doctor(b.doctorId)?.name}${b.coveringFor ? ` (covering for ${doctor(b.coveringFor)?.short})` : ''} · ${fullRange(b)} · ${b.id}`
    : 'Reserving the earliest slot…';
  $('#alertAdvice').textContent = b?.triage === 'er-followup'
    ? `Clinic closed ${b.closedReason === 'sunday' ? 'on Sundays' : 'for today'}: call 911 or go to the nearest emergency room now.`
    : b ? 'Same-day priority slot. If it gets worse before then, call 911.' : '';
  $('#alertAdvice').classList.toggle('er', b?.triage === 'er-followup');
  $('#alertDisplaced').textContent = s.displaced
    ? `Pre-empted: ${s.displaced.patient.name || 'a normal booking'} moved ${formatTime(s.displaced.displacedFrom.time)} → ${s.displaced.range}`
    : '';
  for (const f of ['name', 'address', 'phone']) {
    const input = $(`#er_${f}`);
    if (document.activeElement !== input) input.value = s.patient[f] || '';
    input.closest('label').classList.toggle('awaiting', s.awaiting === f);
    input.closest('label').classList.toggle('done', Boolean(s.patient[f]));
  }
}

// ---------------------------------------------------------------------------
// Booking details form (normal flow): same highlight as the emergency form
// ---------------------------------------------------------------------------
const FIELDS = ['name', 'address', 'phone'];
const detailsComplete = (s) => FIELDS.every((f) => s.patient[f]);

export function renderDetails(s) {
  const panel = $('#detailsPanel');
  const on = s.mode !== 'emergency' && Boolean(s.hold || s.confirmed);
  panel.classList.toggle('hidden', !on);
  if (!on) return;
  const complete = detailsComplete(s);
  panel.classList.toggle('complete', complete);
  $('#detailsNote').textContent = s.confirmed
    ? 'Booked with these details.'
    : s.awaiting === 'confirm' ? 'Final check: say "yes" if these are right, or tell Ava what to fix.'
    : complete ? 'Confirmed. Tap Done on the payment screen.' : 'Check what Ava heard. Click a field to correct it.';
  for (const f of FIELDS) {
    const input = $(`#nd_${f}`);
    if (document.activeElement !== input) input.value = s.patient[f] || '';
    input.disabled = Boolean(s.confirmed);
    input.closest('label').classList.toggle('awaiting', !s.confirmed && s.awaiting === f);
    input.closest('label').classList.toggle('done', Boolean(s.patient[f]));
  }
}

// ---------------------------------------------------------------------------
// Payment modal: opens once the hold has name, address and phone
// ---------------------------------------------------------------------------
export function renderPayment(s, doctor, holdRemainingMs) {
  const modal = $('#payModal');
  const open = Boolean(s.hold) && s.mode !== 'emergency' && s.awaiting === 'payment';
  modal.classList.toggle('hidden', !open);
  if (!open) return;
  const d = doctor(s.hold.doctorId);
  $('#payDoctor').textContent = d ? `${d.name} · ${d.title}` : '';
  $('#payTime').textContent = fullRange(s.hold);
  $('#payHoldId').textContent = s.hold.id;
  $('#payName').textContent = s.patient.name || '—';
  $('#payAddress').textContent = s.patient.address || '—';
  $('#payPhone').textContent = s.patient.phone || '—';
  $('#payCountdown').textContent = fmtCountdown(holdRemainingMs);
  $('#payCountdown').classList.toggle('low', holdRemainingMs < 60_000);
}

// ---------------------------------------------------------------------------
// Availability calendar (month grid + time slots for the chosen day)
// ---------------------------------------------------------------------------
const CAL_TITLE = {
  open: 'Open times available', full: 'Fully booked / unavailable', off: 'Doctor not working',
  closed: 'Clinic closed (Sunday)', past: 'In the past', beyond: 'Not bookable yet (more than 90 days ahead)',
};
const SLOT_TITLE = { open: 'Open: click to book', booked: 'Booked', held: 'On hold', unavailable: 'Unavailable', past: 'Time has passed', emergency: 'Emergency booking' };

export function renderCalendar(cal, { selectedDate, disabled, onDay, onSlot }) {
  const grid = $('#calGrid');
  grid.innerHTML = '';
  for (const w of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) grid.append(el('div', { className: 'cal-wd', textContent: w }));
  if (!cal) { $('#calDay').innerHTML = '<div class="muted small">Loading…</div>'; return; }

  const [y, m] = cal.month.split('-').map(Number);
  $('#calMonth').textContent = new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) grid.append(el('div', { className: 'cal-blank' }));

  for (const d of cal.days) {
    const few = d.status === 'open' && d.open <= 3;
    const cell = el('button', {
      type: 'button',
      className: `cal-cell st-${d.status}${few ? ' few' : ''}${d.date === cal.today ? ' today' : ''}${d.date === selectedDate ? ' selected' : ''}`,
      title: `${CAL_TITLE[d.status] || ''}${d.status === 'open' ? ` (${d.open} open)` : ''}`,
      disabled: !['open', 'full'].includes(d.status),
      onclick: () => onDay(d.date),
    });
    cell.append(el('span', { className: 'cal-num', textContent: String(Number(d.date.slice(8))) }));
    if (d.status === 'open') cell.append(el('span', { className: 'cal-count', textContent: `${d.open}` }));
    grid.append(cell);
  }

  const box = $('#calDay');
  box.innerHTML = '';
  const day = cal.days.find((d) => d.date === selectedDate);
  if (!day) {
    box.append(el('div', { className: 'muted small', textContent: 'Pick a day to see its times.' }));
    return;
  }
  const nice = new Date(`${day.date}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  box.append(el('div', { className: 'cal-day-head', textContent: `${nice} · ${day.open} open` }));
  const list = el('div', { className: 'cal-slots' });
  for (const x of day.slots) {
    list.append(el('button', {
      type: 'button',
      className: `cal-slot ss-${x.status}`,
      textContent: x.label,
      title: SLOT_TITLE[x.status] || x.status,
      disabled: x.status !== 'open' || disabled,
      onclick: () => onSlot(x.id),
    }));
  }
  box.append(list);
}
