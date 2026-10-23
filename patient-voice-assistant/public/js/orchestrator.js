// Conversation brain. The screen + mock clinic are the source of truth; the
// model is steered by re-sending its instructions whenever state changes.
//
// Inputs:  patient transcript (live + final), assistant transcript, UI clicks.
// Outputs: clinic API calls (hold / pay / emergency), a suggested next line
//          (spoken via TTS offline, injected into instructions when live),
//          avatar clip cues, and onChange() for the UI.

import { api } from './api.js';
import {
  detectRedFlag, detectModelEmergency, detectSpecialty, detectDoctor, emergencyDoctorFor,
  parseTimes, matchSlot, isConfirmation, isBookingIntent, isPaymentDone, extractDetails,
  SPECIALTY_DOCTOR,
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
    hold: null,
    confirmed: null,
    emergency: null,
    displaced: null,
    patient: { name: '', address: '', phone: '' },
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
    this.hooks = hooks; // { onChange, say, playClip, isLive, nudge }
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
        this.respond('Your 5-minute hold expired, so I released that slot. Would you like to pick another time?', { nudge: true });
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
    if (s.hold && isPaymentDone(text)) return this.payNow();

    const spec = detectSpecialty(text);
    const doc = detectDoctor(text);
    if (spec && !s.problem) s.problem = text;
    if (spec) s.specialty = spec;

    let picked = false;
    if (doc && doc !== s.doctorId) { this.setDoctor(doc, 'patient'); picked = true; }
    else if (spec && !s.doctorId) { this.setDoctor(SPECIALTY_DOCTOR[spec], 'symptom'); picked = true; }

    if (s.doctorId && !s.confirmed) {
      const times = parseTimes(text);
      const slot = matchSlot(times, this.freeSlots(s.doctorId));
      if (slot) return this.placeHold(slot.id, 'patient');
      if (!picked && isConfirmation(text) && s.proposedSlotId) return this.placeHold(s.proposedSlotId, 'patient');
      if (times.length) {
        return this.respond(`Sorry, that time isn't open with ${this.doctor(s.doctorId).short}. ${this.offerTimes(s.doctorId)}`);
      }
    }

    if (picked) return this.respond(this.offerLine(s.doctorId, s.doctorSource === 'symptom'));
    if (s.confirmed) return this.respond(`You're booked with ${this.doctor(s.confirmed.doctorId).short} at ${s.confirmed.label}. Is there anything else I can help with?`);
    if (!s.doctorId && isBookingIntent(text)) {
      s.awaiting = 'problem';
      return this.respond("Of course. First, can you briefly describe the problem you'd like to be seen for?");
    }
    if (!s.doctorId) return this.respond("I'm sorry to hear that. Could you tell me a little more about your symptoms so I can find the right doctor?");
    if (s.hold) return this.respond('Your slot is on hold. Tap Done on the payment screen to confirm it.');
    return this.respond(this.offerTimes(s.doctorId));
  }

  offerTimes(doctorId) {
    const slots = this.freeSlots(doctorId).slice(0, 3).map((x) => x.label);
    if (!slots.length) return 'There are no open times this week, sorry.';
    return `Open times are ${slots.slice(0, -1).join(', ')}${slots.length > 1 ? ' or ' : ''}${slots.at(-1)}. Which works for you?`;
  }

  offerLine(doctorId, fromSymptom) {
    const d = this.doctor(doctorId);
    const intro = fromSymptom ? `Thanks for explaining. I'd recommend ${d.name}, our ${d.title} doctor.` : `${d.name} it is.`;
    return `${intro} ${this.offerTimes(doctorId)}`;
  }

  // ---- Screen actions ------------------------------------------------------
  selectDoctor(id) {
    return this.queue(async () => {
      if (this.s.mode === 'emergency') return;
      this.setDoctor(id, 'screen');
      this.respond(this.offerLine(id, false), { nudge: true });
    });
  }

  selectSlot(slotId) {
    return this.queue(() => (this.s.mode === 'emergency' ? null : this.placeHold(slotId, 'screen')));
  }

  setDoctor(id, source) {
    Object.assign(this.s, { doctorId: id, doctorSource: source, proposedSlotId: null, awaiting: 'time' });
    this.changed();
  }

  async placeHold(slotId, source) {
    const s = this.s;
    if (s.hold?.slotId === slotId) return;
    if (s.hold) await api.release(s.hold.id).catch(() => {});
    try {
      const res = await api.hold(slotId, s.problem || 'General consultation', s.patient);
      s.hold = res.booking;
      s.doctorId = res.booking.doctorId;
      s.proposedSlotId = null;
      s.awaiting = 'payment';
      this.applyState(res.state);
      const d = this.doctor(res.booking.doctorId);
      this.respond(`Great. I'm holding ${d.short} at ${res.booking.label} for 5 minutes. Please tap Done on the payment screen to confirm.`, { nudge: source === 'screen' });
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
    if (!s.hold) return;
    const res = await api.pay(s.hold.id);
    s.confirmed = res.booking;
    s.hold = null;
    s.awaiting = 'done';
    this.applyState(res.state);
    this.hooks.playClip('confirmed');
    const d = this.doctor(res.booking.doctorId);
    this.respond(`You're all set with ${d.short} at ${res.booking.label}. Your booking ID is ${res.booking.id}, and I've texted you a receipt.`, { nudge: true, kind: 'paid' });
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
    this.hooks.playClip('emergency');

    if (s.hold) { await api.release(s.hold.id).catch(() => {}); s.hold = null; }
    const res = await api.emergency(emergencyDoctorFor(text || phrase), text || phrase, s.patient);
    s.emergency = res.booking;
    s.displaced = res.displaced;
    s.doctorId = res.booking.doctorId;
    this.applyState(res.state);

    const d = this.doctor(res.booking.doctorId);
    const ask = s.awaiting ? ASK[s.awaiting] : '';
    this.respond(
      `This sounds like an emergency. If you're in danger right now, call emergency services, 911. I've reserved ${d.short}'s next same-day slot, ${formatTime(res.booking.time)} today, for you. ${ask}`.trim(),
      { nudge: source !== 'model', kind: 'emergency' }
    );
  }

  async captureDetails(text) {
    const s = this.s;
    // Don't mistake a symptom description for a bare-name answer.
    const symptomatic = detectRedFlag(text) || detectSpecialty(text);
    const found = extractDetails(text, symptomatic ? null : s.awaiting);
    const changed = await this.savePatient(found);
    if (!changed && symptomatic) return; // the triggering sentence itself
    if (!changed) {
      return this.respond(s.awaiting ? `Sorry, I didn't catch that. ${ASK[s.awaiting]}` : this.emergencyWrapUp());
    }
    if (s.awaiting) {
      const first = s.patient.name.split(' ')[0];
      return this.respond(`Thank you${first ? `, ${first}` : ''}. ${ASK[s.awaiting]}`);
    }
    this.respond(this.emergencyWrapUp());
  }

  emergencyWrapUp() {
    const s = this.s;
    const b = s.emergency;
    if (!b) return 'Help is on the way. Stay with me.';
    const d = this.doctor(b.doctorId);
    const first = s.patient.name.split(' ')[0];
    return `Thank you${first ? `, ${first}` : ''}. ${d.name} is expecting you today at ${formatTime(b.time)}. Your emergency booking ID is ${b.id}, and the details are on your phone. If anything gets worse, call 911 immediately.`;
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
    s.awaiting = FIELDS.find((f) => !s.patient[f]) || null;
    this.changed();
    const id = s.emergency?.id || s.hold?.id;
    if (id) {
      const res = await api.updatePatient(id, updates);
      this.applyState(res.state);
    }
    return true;
  }

  // Manual edit from the emergency details form.
  setPatientField(field, value) {
    return this.queue(async () => {
      const changed = await this.savePatient({ [field]: value });
      if (changed && this.s.mode === 'emergency' && !this.s.awaiting) this.respond(this.emergencyWrapUp());
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
      if (s.mode === 'emergency') {
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
        const times = parseTimes(text);
        const slot = times.length === 1 ? matchSlot(times, this.freeSlots(s.doctorId)) : null;
        if (slot) { s.proposedSlotId = slot.id; this.changed(); }
      }
    });
  }

  // ---- Model instructions --------------------------------------------------
  buildInstructions() {
    const s = this.s;
    const docs = (this.snapshot?.doctors || []).map((d) => {
      const slots = d.freeSlots.slice(0, 4).map((x) => x.label).join(', ') || 'none';
      return `- ${d.name} (${d.title}). Open: ${slots}.`;
    }).join('\n');

    const lines = [
      'You are Ava, the friendly voice booking assistant for Maple Clinic. Speak naturally, warmly and briefly: 1-2 short sentences per turn. Never use lists or markdown.',
      'RULE: Always have the patient describe their problem first, then book. Recommend the doctor whose specialty fits, offer up to three of their open times, and let the patient pick.',
      'When the patient picks a time, say you are holding it for 5 minutes and ask them to tap Done on the payment screen. Never invent booking IDs, prices or times that are not listed below; the screen shows IDs.',
      'EMERGENCIES: if the patient mentions chest pain, trouble breathing, stroke signs, heavy bleeding, fainting, a severe allergic reaction, suicidal thoughts, or says it is urgent, say clearly: "This sounds like an emergency. If you are in danger, call emergency services, 911." Then tell them a same-day emergency slot has been reserved and collect their full name, home address and phone number, one at a time. Stay calm and reassuring.',
      '',
      'DOCTORS:',
      docs,
      '',
      'CURRENT STATE (from the clinic screen, always trust this):',
    ];

    if (s.mode === 'emergency') {
      const b = s.emergency;
      const d = b && this.doctor(b.doctorId);
      lines.push(`- EMERGENCY MODE. ${b ? `Emergency booking ${b.id} with ${d.name} today at ${formatTime(b.time)} (payment waived).` : 'Reserving an emergency slot now.'}`);
      lines.push(`- Collected: name=${s.patient.name || 'MISSING'}, address=${s.patient.address || 'MISSING'}, phone=${s.patient.phone || 'MISSING'}.`);
      lines.push(s.awaiting ? `- Ask for the ${s.awaiting} next.` : '- All details collected: confirm the booking ID and reassure the patient.');
    } else {
      if (s.problem) lines.push(`- Problem described: "${s.problem}".`);
      if (s.doctorId) lines.push(`- Selected doctor: ${this.doctor(s.doctorId)?.name}.`);
      if (s.hold) lines.push(`- Slot ON HOLD (5 minutes): ${s.hold.label}, hold ${s.hold.id}. Waiting for the patient to tap Done on the payment screen.`);
      if (s.confirmed) lines.push(`- BOOKED and paid: ${this.doctor(s.confirmed.doctorId)?.name} at ${s.confirmed.label}, booking ID ${s.confirmed.id}. A receipt SMS was sent.`);
      if (!s.problem && !s.doctorId) lines.push('- Nothing booked yet. Ask what brings them in today.');
    }
    if (s.reply) lines.push('', `SUGGESTED NEXT LINE (adapt naturally): "${s.reply}"`);
    return lines.join('\n');
  }

  async reset() {
    this.s = fresh();
    this.applyState((await api.reset()));
  }
}
