// Conversation brain. The screen + mock clinic are the source of truth; the
// model is steered by re-sending its instructions whenever state changes.
//
// Inputs:  patient transcript (live + final), assistant transcript, UI clicks.
// Outputs: clinic API calls (hold / pay / emergency), a suggested next line
//          (spoken via TTS offline, injected into instructions when live),
//          and onChange() for the UI.

import { api } from './api.js';
import {
  detectRedFlag, detectModelEmergency, detectSpecialty, detectDoctor, emergencyDoctorFor,
  parseTimes, matchSlot, isConfirmation, isBookingIntent, isPaymentDone, extractDetails,
  parseChoice, isHoldAnnouncement, extractReadback, isPayPrompt, phoneDigits, formatPhone, cleanAddress, isAddressFollowUp,
  parseDate, parseDayPart, isoDate, parseTimeConstraint, isQuestion, dayFocus, SPECIALTY_DOCTOR,
} from './keywords.js';

const FIELDS = ['name', 'address', 'phone'];
const ASK = {
  name: "What's your full name?",
  address: "What's your home address?",
  phone: "And what's the best phone number to reach you?",
};

function fresh() {
  return {
    mode: 'normal', // 'normal' | 'emergency'
    alert: null, // { source: 'safety-net' | 'model' | 'manual', phrase }
    problem: '',
    specialty: null,
    doctorId: null,
    doctorSource: null,
    proposedSlotId: null,
    offeredSlots: [], // the times Ava last listed: [{ id, time, date, label }]
    proposedLabel: '',
    hold: null,
    confirmed: null,
    emergency: null,
    displaced: null,
    patient: { name: '', address: '', phone: '' },
    phoneBuffer: '', // digits of a phone number spoken across several turns
    awaiting: 'problem',
    reply: '',
    lastUserText: '',
    error: '',
  };
}

export function formatTime(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export class Orchestrator {
  constructor(hooks) {
    this.hooks = hooks; // { onChange, say, isLive, nudge, now, conversationId }
    this.s = fresh();
    this.snapshot = null;
    this.busy = Promise.resolve();
  }

  // Serialize async turns so overlapping events can't race each other.
  queue(fn) {
    this.busy = this.busy.then(fn).catch((err) => {
      this.s.error = err.message;
      this.changed();
    });
    return this.busy;
  }

  changed() {
    this.hooks.onChange?.();
  }

  doctor(id) {
    return this.snapshot?.doctors.find((d) => d.id === id) || null;
  }

  freeSlots(id) {
    return this.doctor(id)?.freeSlots || [];
  }

  now() {
    return this.hooks.now?.() ?? Date.now();
  }

  // The times Ava last listed; falls back to the nearest three.
  offeredSlots(id) {
    const offered = (this.s.offeredSlots || []).filter((x) => x.id.startsWith(`${id}|`));
    return offered.length ? offered : this.freeSlots(id).slice(0, 3);
  }

  // "today" | "tomorrow" | "on Monday" | "on Tuesday, Nov 3"
  onDay(date, capital = false) {
    const today = isoDate(new Date(this.now()));
    const d = new Date(`${date}T12:00:00`);
    const diff = Math.round((d - new Date(`${today}T12:00:00`)) / 86_400_000);
    const wd = d.toLocaleDateString('en-US', { weekday: 'long' });
    const w = diff === 0 ? 'today' : diff === 1 ? 'tomorrow'
      : `on ${diff > 1 && diff < 7 ? wd : `${wd}, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}`;
    return capital ? w[0].toUpperCase() + w.slice(1) : w;
  }

  // Open slots for one date, straight from the clinic calendar (any date
  // within the 90-day horizon, not just the next two weeks).
  async daySlots(doctorId, date) {
    const cal = await api.availability(doctorId, date.slice(0, 7));
    const day = cal.days.find((x) => x.date === date);
    return (day?.slots || []).filter((x) => x.status === 'open')
      .map((x) => ({ id: x.id, doctorId, date, time: x.time, label: `${formatTime(x.time)} ${this.onDay(date)}` }));
  }

  // Open slots on a date and/or part of day, soonest first.
  async openSlots(doctorId, { date = null, part = null, constraint = null } = {}) {
    let list = date ? await this.daySlots(doctorId, date) : this.freeSlots(doctorId);
    if (part === 'morning') list = list.filter((x) => x.time < '12:00');
    if (part === 'afternoon') list = list.filter((x) => x.time >= '12:00');
    if (constraint?.kind === 'after') list = list.filter((x) => x.time > constraint.time);
    if (constraint?.kind === 'from') list = list.filter((x) => x.time >= constraint.time);
    if (constraint?.kind === 'before') list = list.filter((x) => x.time < constraint.time);
    return list;
  }

  // An offer line for a requested day / part of day / "after 3", falling back
  // to the nearest times that still fit the part of day and constraint.
  async offerFor(doctorId, { date = null, part = null, constraint = null } = {}) {
    const list = await this.openSlots(doctorId, { date, part, constraint });
    if (list.length) return this.offerTimes(doctorId, list, { date });
    const when = [
      date ? this.onDay(date) : '',
      part ? `in the ${part}` : '',
      constraint ? `${constraint.kind === 'before' ? 'before' : 'after'} ${formatTime(constraint.time)}` : '',
    ].filter(Boolean).join(' ');
    const other = date ? await this.openSlots(doctorId, { part, constraint }) : [];
    return `${this.doctor(doctorId).short} has nothing open ${when}. ${this.offerTimes(doctorId, other.length ? other : undefined)}`;
  }

  // Part of day / "after 3" from this turn, or remembered from an earlier one
  // when this turn only names a day ("after 3?" … "Wednesday then").
  timePref(text, date) {
    const part = parseDayPart(text);
    const constraint = parseTimeConstraint(text);
    if (part || constraint) { this.s.timePref = { part, constraint }; return { part, constraint }; }
    return date && this.s.timePref ? this.s.timePref : { part: null, constraint: null };
  }

  // Where a spoken time is looked up: the date said in this sentence, else the
  // day being discussed ("Thursday?" … "3:30 then"), else the soonest one.
  async slotPool(doctorId, date) {
    const day = date || this.s.focusDate;
    return day ? this.daySlots(doctorId, day) : this.freeSlots(doctorId);
  }

  // Ava said she's holding a specific time. If it's open, make the screen
  // match; if it isn't, correct her out loud so the patient isn't misled.
  // Returns true if it acted.
  async checkAnnouncedHold(text) {
    const s = this.s;
    const now = this.now();
    const focus = dayFocus(text, now);
    const times = parseTimes(text, now);
    if (times.length !== 1 || focus === 'multi') return false;
    const date = focus || times[0].date || null;
    const h = s.hold;
    if (h && h.time === times[0].time && (!date || h.date === date)) return false; // matches the hold
    // Payment screen is open: the hold can't move; restate the real time.
    if (h && s.awaiting === 'payment') {
      this.respond(`Sorry, a correction: your appointment is ${h.range} with ${this.doctor(h.doctorId).short}, as shown on the payment screen.`, { nudge: true });
      return true;
    }
    const slot = matchSlot([{ time: times[0].time, date }], await this.slotPool(s.doctorId, date));
    if (slot) {
      await this.placeHold(slot.id, 'assistant', { nudge: !/\b(?:name|address|phone)\b/i.test(text) });
      return true;
    }
    const day = date || s.focusDate;
    const said = `${formatTime(times[0].time)}${day ? ` ${this.onDay(day)}` : ''}`;
    const keep = s.hold ? ` Your appointment is still ${s.hold.range}.` : '';
    const alt = s.hold ? '' : ` ${await this.offerFor(s.doctorId, { date: day })}`;
    this.respond(`Sorry, I need to correct myself: ${said} is not available with ${this.doctor(s.doctorId).short}.${keep}${alt}`, { nudge: true });
    return true;
  }

  // A time the patient asked about: confirm before holding it.
  propose(slot) {
    Object.assign(this.s, { proposedSlotId: slot.id, proposedLabel: slot.label });
    this.respond(`Yes, ${slot.label} is open with ${this.doctor(slot.doctorId || this.s.doctorId).short}. Shall I book it for you?`);
  }

  // While a slot is held: a new day or time moves the hold (details are kept).
  // Returns true if the turn was about changing the time.
  async rescheduleTurn(text) {
    const s = this.s;
    const now = this.now();
    const date = parseDate(text, now);
    const { part, constraint } = this.timePref(text, date);
    if (s.proposedSlotId && isConfirmation(text)) { await this.placeHold(s.proposedSlotId, 'patient'); return true; }
    // Mid address/phone, only an explicit change counts ("Thursday instead?"),
    // so "I live at 22…" or a phone number isn't mistaken for a time.
    if (s.awaiting === 'phone' || s.awaiting === 'address') {
      const explicit = /\b(?:change|instead|different|another|move|rather|actually|switch|reschedule)\b/i.test(text) || isQuestion(text);
      if (!(explicit && (date || constraint || parseDayPart(text)))) return false;
    }
    const times = parseTimes(text, now);
    if (date) s.focusDate = date;
    if (times.length && !parseTimeConstraint(text)) {
      const pool = await this.slotPool(s.doctorId, date);
      const slot = matchSlot(times, pool);
      if (slot && slot.id !== s.hold.slotId) {
        if (isQuestion(text)) { this.propose(slot); return true; }
        await this.placeHold(slot.id, 'patient');
        return true;
      }
      if (!slot) {
        s.rescheduleOffer = true;
        const day = date || s.focusDate;
        const asked = `${formatTime(times[0].time)}${day ? ` ${this.onDay(day)}` : ''}`;
        this.respond(`Sorry, ${asked} isn't available with ${this.doctor(s.doctorId).short}. ${await this.offerFor(s.doctorId, { date: day, part, constraint })}`);
        return true;
      }
    }
    if (s.rescheduleOffer) {
      const choice = parseChoice(text);
      const pick = choice !== null ? this.offeredSlots(s.doctorId).at(choice) : null;
      if (pick) { await this.placeHold(pick.id, 'patient'); return true; }
    }
    if (date || constraint || (part && /\b(?:change|instead|different|another|move|book|rather)\b/i.test(text))) {
      s.rescheduleOffer = true;
      this.respond(`Sure, we can change the time. ${await this.offerFor(s.doctorId, { date, part, constraint })}`);
      return true;
    }
    return false;
  }

  missingField() {
    return FIELDS.find((f) => !this.s.patient[f]) || null;
  }

  collectingDetails() {
    return Boolean(this.s.hold) && FIELDS.includes(this.s.awaiting);
  }

  respond(text, { nudge = false, kind = 'info' } = {}) {
    this.s.reply = text;
    this.changed();
    if (!this.hooks.isLive()) this.hooks.say(text);
    else if (nudge) this.hooks.nudge(kind);
  }

  // ---- Server state --------------------------------------------------------
  applyState(snapshot) {
    this.snapshot = snapshot;
    const find = (b) => (b ? snapshot.bookings.find((x) => x.id === b.id) || null : null);
    const s = this.s;
    if (s.hold) {
      const live = find(s.hold);
      if (!live) {
        s.hold = null;
        s.awaiting = 'time';
        this.respond('The reservation on that time ran out, so I released it. Would you like to pick another time?', { nudge: true });
      } else {
        s.hold = live;
      }
    }
    if (s.confirmed) s.confirmed = find(s.confirmed) || s.confirmed;
    if (s.emergency) s.emergency = find(s.emergency) || s.emergency;
    if (s.displaced) s.displaced = find(s.displaced) || s.displaced;
    this.changed();
  }

  async refresh() {
    this.applyState(await api.state());
  }

  // ---- Patient speech ------------------------------------------------------
  handleUser(text, { final = true } = {}) {
    if (!String(text).trim()) return;
    // Safety net runs on partial transcripts too: fastest possible alert.
    if (this.s.mode !== 'emergency') {
      const flag = detectRedFlag(text);
      if (flag) {
        this.s.lastUserText = text;
        return this.queue(() => this.triggerEmergency('safety-net', flag, text));
      }
    }
    if (!final) return;
    this.s.lastUserText = text;
    return this.queue(() => (this.s.mode === 'emergency' ? this.captureDetails(text) : this.normalTurn(text)));
  }

  async normalTurn(text) {
    const s = this.s;
    s.error = '';
    s.reply = ''; // never let Ava repeat the previous turn's line
    // A different day/time while a slot is held (before payment) moves the hold.
    if (s.hold && s.awaiting !== 'payment' && await this.rescheduleTurn(text)) return;
    if (this.collectingDetails()) {
      if (isPaymentDone(text)) return this.respond(`Almost done, I just need a couple of details first. ${ASK[s.awaiting]}`);
      return this.captureDetails(text);
    }
    if (s.hold && s.awaiting === 'confirm') return this.confirmTurn(text);
    if (s.hold && isPaymentDone(text)) return this.payNow();

    const spec = detectSpecialty(text);
    const doc = detectDoctor(text);
    if (spec && !s.problem) s.problem = text;
    if (spec) s.specialty = spec;

    let picked = false;
    if (doc && doc !== s.doctorId) { this.setDoctor(doc, 'patient'); picked = true; }
    else if (spec && !s.doctorId) { this.setDoctor(SPECIALTY_DOCTOR[spec], 'symptom'); picked = true; }

    const now = this.now();
    const date = parseDate(text, now);
    const { part, constraint } = this.timePref(text, date);
    if (date) s.focusDate = date;
    if (s.doctorId && !s.confirmed) {
      const times = parseTimeConstraint(text) ? [] : parseTimes(text, now);
      if (times.length) {
        const pool = await this.slotPool(s.doctorId, date);
        const slot = matchSlot(times, pool);
        // "Do you have 3 PM Wednesday?" → confirm first; "3 PM Wednesday works" → hold.
        if (slot) return isQuestion(text) ? this.propose(slot) : this.placeHold(slot.id, 'patient');
      }
      const choice = !picked && !s.hold ? parseChoice(text) : null;
      if (choice !== null) {
        const pick = this.offeredSlots(s.doctorId).at(choice);
        if (pick) return this.placeHold(pick.id, 'patient');
      }
      if (!picked && isConfirmation(text) && s.proposedSlotId) return this.placeHold(s.proposedSlotId, 'patient');
      if (times.length) {
        const day = date || s.focusDate;
        return this.respond(`Sorry, ${formatTime(times[0].time)}${day ? ` ${this.onDay(day)}` : ''} isn't available with ${this.doctor(s.doctorId).short}. ${await this.offerFor(s.doctorId, { date: day, part })}`);
      }
      if (!picked && !s.hold && (date || part || constraint)) return this.respond(await this.offerFor(s.doctorId, { date, part, constraint }));
    }

    if (picked) return this.respond(await this.offerLine(s.doctorId, s.doctorSource === 'symptom', { date, part, constraint }));
    if (s.confirmed) return this.respond(`You're booked with ${this.doctor(s.confirmed.doctorId).short} for ${s.confirmed.range}. Is there anything else I can help with?`);
    if (!s.doctorId && isBookingIntent(text)) {
      s.awaiting = 'problem';
      return this.respond("Of course. First, can you briefly describe the problem you'd like to be seen for?");
    }
    if (!s.doctorId) return this.respond("I'm sorry to hear that. Could you tell me a little more about your symptoms so I can find the right doctor?");
    if (s.hold) return this.respond('Your slot is on hold. Tap Done on the payment screen to confirm it.');
    return this.respond(this.offerTimes(s.doctorId));
  }

  // Up to three times, nearest first. With a date, times are said once per day.
  offerTimes(doctorId, list = this.freeSlots(doctorId), { date = null } = {}) {
    const offered = list.slice(0, 3);
    this.s.offeredSlots = offered.map(({ id, time, date: d, label }) => ({ id, time, date: d, label }));
    const days = new Set(offered.map((x) => x.date));
    this.s.focusDate = date || (days.size === 1 ? [...days][0] : null);
    if (!offered.length) return `${this.doctor(doctorId).short} has no open times in the next two weeks. You can pick a later date on the calendar.`;
    const join = (xs) => `${xs.slice(0, -1).join(', ')}${xs.length > 1 ? ' or ' : ''}${xs.at(-1)}`;
    if (date) return `${this.onDay(date, true)}, the open times are ${join(offered.map((x) => formatTime(x.time)))}. Which works for you?`;
    return `The nearest open times are ${join(offered.map((x) => x.label))}. Which works for you?`;
  }

  async offerLine(doctorId, fromSymptom, want = {}) {
    const d = this.doctor(doctorId);
    const intro = fromSymptom ? `Thanks for explaining. I'd recommend ${d.name}, our ${d.title} doctor.` : `${d.name} it is.`;
    return `${intro} ${want.date || want.part || want.constraint ? await this.offerFor(doctorId, want) : this.offerTimes(doctorId)}`;
  }

  // ---- Screen actions ------------------------------------------------------
  selectDoctor(id) {
    return this.queue(async () => {
      if (this.s.mode === 'emergency') return;
      this.setDoctor(id, 'screen');
      // Silent: the screen shows the doctor's times. The line only goes into
      // Ava's instructions, for whenever the patient speaks next.
      this.s.reply = await this.offerLine(id, false);
      this.changed();
    });
  }

  selectSlot(slotId) {
    return this.queue(() => (this.s.mode === 'emergency' ? null : this.placeHold(slotId, 'screen')));
  }

  setDoctor(id, source) {
    Object.assign(this.s, { doctorId: id, doctorSource: source, proposedSlotId: null, proposedLabel: '', awaiting: 'time' });
    this.changed();
  }

  // source: 'patient' | 'screen' | 'assistant' (Ava announced a hold herself).
  async placeHold(slotId, source, { nudge = source === 'screen' } = {}) {
    const s = this.s;
    if (s.hold?.slotId === slotId) return;
    if (s.hold) await api.release(s.hold.id).catch(() => {});
    try {
      const conversationId = await this.hooks.conversationId?.();
      const res = await api.hold(slotId, s.problem || 'General consultation', s.patient, { conversationId, specialty: s.specialty, doctorSource: s.doctorSource });
      s.hold = res.booking;
      s.doctorId = res.booking.doctorId;
      s.proposedSlotId = null;
      s.proposedLabel = '';
      s.rescheduleOffer = false;
      s.timePref = null;
      s.focusDate = res.booking.date;
      s.awaiting = this.missingField() || 'confirm';
      this.applyState(res.state);
      const d = this.doctor(res.booking.doctorId);
      const held = source === 'assistant' ? '' : `Great, I'm holding ${d.short} for you, ${res.booking.range}. `;
      const next = s.awaiting === 'confirm'
        ? this.detailsWrapUp()
        : FIELDS.some((f) => s.patient[f]) ? ASK[s.awaiting] : `To finish the booking I just need a few details. ${ASK[s.awaiting]}`;
      this.respond(`${held}${next}`, { nudge });
    } catch (err) {
      s.hold = null;
      await this.refresh();
      this.respond(`${err.message} ${this.offerTimes(s.doctorId)}`, { nudge: source === 'screen' });
    }
  }

  pay() {
    return this.queue(() => this.payNow());
  }

  // Un-queued body of pay(), safe to call from inside a queued turn.
  async payNow() {
    const s = this.s;
    if (!s.hold || s.awaiting !== 'payment') return;
    const res = await api.pay(s.hold.id);
    s.confirmed = res.booking;
    s.hold = null;
    s.awaiting = 'done';
    this.applyState(res.state);
    const d = this.doctor(res.booking.doctorId);
    this.respond(`You're all set with ${d.short}, ${res.booking.range}. Your booking ID is ${res.booking.id}, and I've texted you a receipt.`, { nudge: true, kind: 'paid' });
  }

  cancelHold() {
    return this.queue(async () => {
      const s = this.s;
      if (!s.hold) return;
      const res = await api.release(s.hold.id);
      s.hold = null;
      s.awaiting = 'time';
      this.applyState(res.state);
      this.respond(`No problem, I've released that time. ${this.offerTimes(s.doctorId)}`, { nudge: true });
    });
  }

  manualEmergency() {
    return this.queue(() => this.triggerEmergency('manual', 'manual trigger', this.s.lastUserText));
  }

  // ---- Emergency -----------------------------------------------------------
  async triggerEmergency(source, phrase, text = '') {
    const s = this.s;
    if (s.mode === 'emergency') return;
    s.mode = 'emergency';
    s.alert = { source, phrase, at: Date.now() };
    s.awaiting = FIELDS.find((f) => !s.patient[f]) || null;
    this.changed(); // character turns red immediately

    if (s.hold) { await api.release(s.hold.id).catch(() => {}); s.hold = null; }
    const conversationId = await this.hooks.conversationId?.();
    // Route on everything the patient has said, not just the trigger sentence
    // ("very emergency condition" alone says nothing about the hip).
    const context = [s.problem, text || phrase].filter(Boolean).join('. ');
    let doctorId = emergencyDoctorFor(context);
    if (doctorId === 'patel' && s.doctorId && s.doctorSource !== 'screen') doctorId = s.doctorId;
    const res = await api.emergency(doctorId, context, s.patient, { conversationId, specialty: detectSpecialty(context), alertSource: source, alertPhrase: phrase });
    s.emergency = res.booking;
    s.displaced = res.displaced;
    s.doctorId = res.booking.doctorId;
    this.applyState(res.state);

    const ask = s.awaiting ? ASK[s.awaiting] : '';
    this.respond(`${this.emergencyLine(res.booking)} ${ask}`.trim(), { nudge: source !== 'model', kind: 'emergency' });
  }

  async captureDetails(text) {
    const s = this.s;
    // Don't mistake a symptom description for a bare-name answer.
    const symptomatic = detectRedFlag(text) || detectSpecialty(text);
    const found = extractDetails(text, symptomatic ? null : s.awaiting);
    if (s.awaiting === 'phone' && !found.phone) {
      const digits = phoneDigits(text);
      if (digits) {
        s.phoneBuffer += digits;
        if (s.phoneBuffer.length < 10) {
          if (!this.hooks.isLive()) this.respond('Got it, go on.');
          return;
        }
        found.phone = formatPhone(s.phoneBuffer.slice(0, 15));
      }
    }
    const changed = await this.savePatient(found);
    if (!changed && symptomatic && s.mode === 'emergency') return; // the triggering sentence itself
    const asking = FIELDS.includes(s.awaiting);
    if (!changed) {
      return this.respond(asking ? `Sorry, I didn't catch that. ${ASK[s.awaiting]}` : this.detailsWrapUp());
    }
    if (asking) {
      const first = s.patient.name.split(' ')[0];
      return this.respond(`Thank you${first ? `, ${first}` : ''}. ${ASK[s.awaiting]}`);
    }
    this.respond(this.detailsWrapUp());
  }

  detailsWrapUp() {
    if (this.s.mode === 'emergency') return this.emergencyWrapUp();
    const { name, address, phone } = this.s.patient;
    return `Thank you, ${name.split(' ')[0]}. Just a final check: your name is ${name}, your address is ${address}, and your phone number is ${phone}. Is that all correct?`;
  }

  // Answer to the final check. Yes → payment screen (chat pauses); a
  // correction → update and read back again.
  async confirmTurn(text) {
    const s = this.s;
    const found = extractDetails(text, null);
    const digits = phoneDigits(text);
    if (!found.phone && /\b(?:phone|number)\b/i.test(text) && digits.length >= 7) found.phone = formatPhone(digits.slice(0, 15));
    if (await this.savePatient(found)) return this.respond(this.detailsWrapUp());
    if (isConfirmation(text)) {
      s.awaiting = 'payment';
      this.changed();
      return this.respond('Great. The payment screen is open now. Tap Done to confirm your booking, or Release hold if you want a different time.');
    }
    const t = text.toLowerCase();
    const field = /\bname\b/.test(t) ? 'name' : /\baddress\b/.test(t) ? 'address' : /\b(?:phone|number)\b/.test(t) ? 'phone' : null;
    if (field) {
      s.awaiting = field;
      this.changed();
      return this.respond(`No problem, let's fix that. ${ASK[field]}`);
    }
    return this.respond('No problem. Which one should I fix: your name, your address, or your phone number?');
  }

  // What Ava says when the emergency is triggered, by triage outcome.
  emergencyLine(b) {
    const d = this.doctor(b.doctorId);
    const cover = b.coveringFor ? `, covering for ${this.doctor(b.coveringFor).short}` : '';
    if (b.triage === 'er-followup') {
      const why = b.closedReason === 'sunday' ? 'The clinic is closed on Sundays' : 'The clinic is closed for today';
      return `This sounds like an emergency. ${why}, so please call 911 or go to the nearest emergency room right now. I've also booked you a priority follow-up with ${d.name}, ${b.range}.`;
    }
    return `This sounds like an emergency. If you're in danger right now, call 911. I've given you ${d.name}'s earliest priority slot${cover}, ${b.range}.`;
  }

  emergencyWrapUp() {
    const s = this.s;
    const b = s.emergency;
    if (!b) return 'Help is on the way. Stay with me.';
    const d = this.doctor(b.doctorId);
    const first = s.patient.name.split(' ')[0];
    const thanks = `Thank you${first ? `, ${first}` : ''}.`;
    if (b.triage === 'er-followup') {
      return `${thanks} Please call 911 or go to the nearest emergency room now. Your follow-up with ${d.name} is ${b.range}, booking ID ${b.id}, and the details are on your phone.`;
    }
    return `${thanks} ${d.name} is expecting you ${b.range}. Your emergency booking ID is ${b.id}, and the details are on your phone. If anything gets worse, call 911 immediately.`;
  }

  // Returns true if anything new was captured.
  async savePatient(fields) {
    const s = this.s;
    const updates = {};
    for (const k of FIELDS) {
      const v = (fields[k] || '').trim();
      if (v && v !== s.patient[k]) updates[k] = v;
    }
    if (!Object.keys(updates).length) return false;
    Object.assign(s.patient, updates);
    if (updates.phone) s.phoneBuffer = '';
    s.awaiting = this.missingField() || (s.mode !== 'emergency' && s.hold ? 'confirm' : null);
    this.changed();
    const id = s.emergency?.id || s.hold?.id;
    if (id) {
      const res = await api.updatePatient(id, updates);
      this.applyState(res.state);
    }
    return true;
  }

  // Manual edit from the emergency or booking details form.
  setPatientField(field, value) {
    return this.queue(async () => {
      const wasAsking = FIELDS.includes(this.s.awaiting);
      const changed = await this.savePatient({ [field]: value });
      if (!changed || !wasAsking || FIELDS.includes(this.s.awaiting)) return;
      if (this.s.mode === 'emergency') this.respond(this.emergencyWrapUp());
      else if (this.s.hold) this.respond(this.detailsWrapUp(), { nudge: true });
    });
  }

  // ---- Assistant speech ----------------------------------------------------
  handleAssistant(text) {
    if (!String(text).trim()) return;
    return this.queue(async () => {
      const s = this.s;
      if (s.mode !== 'emergency') {
        const flag = detectModelEmergency(text);
        if (flag) return this.triggerEmergency('model', flag, s.lastUserText || text);
      }
      const normalHold = s.mode !== 'emergency' && s.hold;
      if (s.mode === 'emergency' || normalHold) {
        // Ava's read-back wins over our own transcript parsing.
        await this.savePatient(extractReadback(text));
        // Ava moved on to payment right after the patient said yes to the final check.
        if (normalHold && isPayPrompt(text) && s.awaiting === 'confirm' && isConfirmation(s.lastUserText)) { s.awaiting = 'payment'; this.changed(); }
        // Ava asked a follow-up about the address anyway: steer her straight back.
        if (isAddressFollowUp(text)) {
          // If we missed the address, the patient's last answer was it.
          if (!s.patient.address && s.lastUserText && !detectRedFlag(s.lastUserText)) {
            const guess = cleanAddress(s.lastUserText);
            if (guess) await this.savePatient({ address: guess });
          }
          const next = FIELDS.includes(s.awaiting) ? ASK[s.awaiting] : this.detailsWrapUp();
          return this.respond(`Actually, the address you gave is all I need. ${next}`, { nudge: true });
        }
      }
      // Ava named a time for the hold/booking: it must match the screen.
      if (s.mode !== 'emergency' && !s.confirmed && s.doctorId) {
        const confirmish = s.hold && /\b(?:confirmed|booked|booking is|appointment is|appointment for|set for|all set)\b/i.test(text);
        if ((isHoldAnnouncement(text) || confirmish) && await this.checkAnnouncedHold(text)) return;
      }
      if (s.mode === 'emergency' || this.collectingDetails()) {
        // Track which detail the model just asked for, so a bare reply is understood.
        const t = text.toLowerCase();
        const asked = [['name', t.lastIndexOf('name')], ['address', t.lastIndexOf('address')], ['phone', Math.max(t.lastIndexOf('phone'), t.lastIndexOf('number'))]]
          .filter(([f, i]) => i >= 0 && !s.patient[f])
          .sort((a, b) => b[1] - a[1])[0];
        if (asked) { s.awaiting = asked[0]; this.changed(); }
        return;
      }
      if (s.confirmed) return;
      const doc = detectDoctor(text);
      if (doc && !s.doctorId) this.setDoctor(doc, 'assistant');
      if (s.doctorId && !s.hold) {
        // Track the day Ava is talking about, so "3:30 then" means that day.
        const focus = dayFocus(text, this.now());
        if (focus === 'multi') s.focusDate = null;
        else if (focus) s.focusDate = focus;
        const times = parseTimes(text, this.now()).map((x) => (focus === 'multi' ? { ...x, date: null } : x));
        const date = focus && focus !== 'multi' ? focus : null;
        const pool = await this.slotPool(s.doctorId, date);
        const slot = times.length === 1 ? matchSlot(times, pool) : null;
        // Ava said she's holding a specific time: make the screen match.
        if (slot && isHoldAnnouncement(text)) {
          const askedDetail = /\b(?:name|address|phone)\b/i.test(text);
          return this.placeHold(slot.id, 'assistant', { nudge: !askedDetail });
        }
        if (slot) { s.proposedSlotId = slot.id; s.proposedLabel = slot.label; this.changed(); }
        const listed = times.map((x) => matchSlot([x], pool)).filter(Boolean);
        if (listed.length > 1) s.offeredSlots = listed.map(({ id, time, date: d, label }) => ({ id, time, date: d, label }));
      }
    });
  }

  // ---- Model instructions --------------------------------------------------
  buildInstructions() {
    const s = this.s;
    const docs = (this.snapshot?.doctors || []).map((d) => {
      const slots = d.freeSlots.slice(0, 4).map((x) => x.label).join(', ') || 'none in the next two weeks';
      return `- ${d.name} (${d.title}). Nearest open: ${slots}.`;
    }).join('\n');
    const nowText = new Date(this.now()).toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    // The selected doctor's open times for the next two weeks, grouped by day.
    const sel = s.doctorId && this.doctor(s.doctorId);
    const byDay = [];
    for (const x of sel?.freeSlots || []) {
      const last = byDay.at(-1);
      if (last?.date === x.date) last.times.push(formatTime(x.time));
      else byDay.push({ date: x.date, times: [formatTime(x.time)] });
    }
    const dayName = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    const lines = [
      'You are Ava, the friendly voice booking assistant for Maple Clinic. Speak naturally, warmly and briefly: 1-2 short sentences per turn. Never use lists or markdown.',
      `CURRENT DATE AND TIME: ${nowText} (clinic local time). Use this for everything about dates: "today", "tomorrow" and weekday names are relative to it.`,
      `CLINIC HOURS: ${this.snapshot?.clinicHours || 'Monday to Friday, 9 AM to 12 PM and 2 PM to 4 PM'}. Appointments are 30 minutes.`,
      'RULE: Always have the patient describe their problem first, then book. Recommend the doctor whose specialty fits, offer up to three of their NEAREST open times from now (never list more than three times in one turn) (the lists below are sorted soonest first), and let the patient pick. Never offer a time in the past, on a Sunday, or one that is not listed. Saturdays are normal working days. The OPEN TIMES list is the only truth about availability: a weekday is open if it appears there. Never say a doctor or the clinic is "closed on Wednesdays" (or any weekday); if a specific date is missing from the list, say that date has no open times. Never say you are holding or booking a time unless the NEXT LINE says so. If the patient asks for a particular day, the morning/afternoon, or "after/before" a time, only offer open times that match; if none match, say so and offer the nearest alternatives. When the patient gives only a time ("3:30 then"), it means the day you were just discussing. A question like "do you have anything after 3?" is NOT a choice: never hold a time until the patient picks one. If the patient wants a different day or time after you are holding one, offer alternatives; the screen moves the hold when they pick, and their details are kept. Say days relative to today ("tomorrow", "on Monday") and add the date when it is more than a week away.',
      'When the patient picks a time, say you are holding it for them and give the appointment as a 30-minute range (for example "11:00 AM to 11:30 AM today"); never mention how long the hold lasts. Then collect their full name, home address and phone number, one question at a time. Accept the address exactly as the patient says it: never ask for a city, province, postal code or unit. After all three are collected, do a final check: read them back in this form: "Just a final check: your name is ..., your address is ..., and your phone number is ... Is that all correct?" (phone as digits). If the patient corrects something, update it and read all three back again. Only when the patient says yes, tell them the payment screen is open and to tap Done to confirm (or Release hold for a different time); then stay quiet until the screen reports what they tapped. Never invent booking IDs, prices or times that are not listed below; the screen shows IDs.',
      'ADDRESS RULE: whatever the patient says for their address the first time is final, even if it is only a number, only a street, misheard or unusual. NEVER ask any follow-up about the address: no street name, house number, city, province, state, postal code, ZIP, unit, spelling or "full address". Never ask them to repeat or complete it. Acknowledge briefly and go straight to the phone number.',
      'EMERGENCIES: if the patient mentions chest pain, trouble breathing, stroke signs, heavy bleeding, fainting, a severe allergic reaction, suicidal thoughts, a baby with a fever, a head injury, poisoning, sudden confusion, severe abdominal pain, choking, a bone sticking out or a limb bent the wrong way, a bad burn, bleeding during pregnancy, or feeling like they are dying, or says it is urgent (but not "not urgent" or "urgent care"), say clearly: "This sounds like an emergency. If you are in danger, call emergency services, 911." Then tell them what the clinic screen reserved (a same-day priority slot, or, when the clinic is closed, an ER visit now plus a priority follow-up) and collect their full name, home address and phone number, one at a time (never ask for city or postal code). Stay calm and reassuring.',
      '',
      'DOCTORS:',
      docs,
      ...(sel ? ['', `OPEN TIMES FOR ${sel.name.toUpperCase()} (next two weeks):`, ...byDay.map((x) => `- ${dayName(x.date)}: ${x.times.join(', ')}`)] : []),
      '',
      'CURRENT STATE (from the clinic screen, always trust this):',
    ];

    if (s.mode === 'emergency') {
      const b = s.emergency;
      const d = b && this.doctor(b.doctorId);
      lines.push(`- EMERGENCY MODE. ${b ? `Emergency booking ${b.id} with ${d.name}, ${b.range} (payment waived).` : 'Reserving an emergency slot now.'}`);
      if (b?.triage === 'er-followup') lines.push(`- The clinic is CLOSED right now (${b.closedReason === 'sunday' ? 'Sunday' : "today's hours are over"}). Tell the patient to call 911 or go to the nearest emergency room now; the booking above is a priority FOLLOW-UP, not an appointment for today.`);
      else if (b) lines.push(`- Same-day priority slot${b.coveringFor ? ` (${d.name} is covering for ${this.doctor(b.coveringFor)?.name}, who is not in today)` : ''}. If they are in danger before then, call 911.`);
      lines.push(`- Collected: name=${s.patient.name || 'MISSING'}, address=${s.patient.address || 'MISSING'}, phone=${s.patient.phone || 'MISSING'}.`);
      lines.push(s.patient.address ? '- The address is complete as given. Do not ask for city, province or postal code.' : '- When the patient gives an address, accept it exactly as said. Never ask for city, province or postal code.');
      lines.push(s.awaiting ? `- Ask for the ${s.awaiting} next.` : '- All details collected: confirm the booking ID and reassure the patient.');
    } else {
      if (s.problem) lines.push(`- Problem described: "${s.problem}".`);
      if (s.doctorId) lines.push(`- Selected doctor: ${this.doctor(s.doctorId)?.name}.`);
      if (s.hold) {
        lines.push(`- Slot ON HOLD: ${s.hold.range}, hold ${s.hold.id}. Do not mention how long the hold lasts.`);
        lines.push(`- Collected: name=${s.patient.name || 'MISSING'}, address=${s.patient.address || 'MISSING'}, phone=${s.patient.phone || 'MISSING'}.`);
        lines.push(s.patient.address ? '- The address is complete as given. Do not ask for city, province or postal code.' : '- When the patient gives an address, accept it exactly as said. Never ask for city, province or postal code.');
        if (this.collectingDetails()) lines.push(`- Ask for the ${s.awaiting} next. Then do the final check of all three details.`);
        else if (s.awaiting === 'confirm') lines.push('- All details collected. Do the final check now: read all three back and ask "Is that all correct?". Do NOT mention payment until the patient says yes.');
        else lines.push('- The patient confirmed their details. The payment screen is open and the conversation is paused. Say nothing more until the screen reports Done or Release hold.');
      }
      if (s.confirmed) lines.push(`- BOOKED and paid: ${this.doctor(s.confirmed.doctorId)?.name}, ${s.confirmed.range}, booking ID ${s.confirmed.id}. A receipt SMS was sent.`);
      if (!s.problem && !s.doctorId) lines.push('- Nothing booked yet. Ask what brings them in today.');
    }
    if (this.resumeTranscript?.length) {
      lines.push('', 'EARLIER IN THIS CONVERSATION (before a page refresh, continue from here):');
      for (const m of this.resumeTranscript) lines.push(`${m.role === 'user' ? 'Patient' : 'Ava'}: ${m.text}`);
    }
    if (s.reply) lines.push('', `NEXT LINE: say this now. Keep every doctor, day, date and time exactly as written; you may only smooth the wording: "${s.reply}"`);
    return lines.join('\n');
  }

  async reset() {
    this.s = fresh();
    this.resumeTranscript = [];
    this.applyState((await api.reset()));
  }
}
