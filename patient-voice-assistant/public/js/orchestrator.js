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
  parseChoice, isHoldAnnouncement, extractReadback, isPayPrompt, phoneDigits, formatPhone, cleanAddress, isAddressFollowUp, SPECIALTY_DOCTOR,
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
    offeredSlotIds: [],
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

  // The times Ava last listed, still free; falls back to the first three.
  offeredSlots(id) {
    const free = this.freeSlots(id);
    const offered = this.s.offeredSlotIds.map((sid) => free.find((x) => x.id === sid)).filter(Boolean);
    return offered.length ? offered : free.slice(0, 3);
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

    if (s.doctorId && !s.confirmed) {
      const times = parseTimes(text);
      const slot = matchSlot(times, this.freeSlots(s.doctorId));
      if (slot) return this.placeHold(slot.id, 'patient');
      const choice = !picked && !s.hold ? parseChoice(text) : null;
      if (choice !== null) {
        const pick = this.offeredSlots(s.doctorId).at(choice);
        if (pick) return this.placeHold(pick.id, 'patient');
      }
      if (!picked && isConfirmation(text) && s.proposedSlotId) return this.placeHold(s.proposedSlotId, 'patient');
      if (times.length) {
        return this.respond(`Sorry, that time isn't open with ${this.doctor(s.doctorId).short}. ${this.offerTimes(s.doctorId)}`);
      }
    }

    if (picked) return this.respond(this.offerLine(s.doctorId, s.doctorSource === 'symptom'));
    if (s.confirmed) return this.respond(`You're booked with ${this.doctor(s.confirmed.doctorId).short} for ${s.confirmed.range}. Is there anything else I can help with?`);
    if (!s.doctorId && isBookingIntent(text)) {
      s.awaiting = 'problem';
      return this.respond("Of course. First, can you briefly describe the problem you'd like to be seen for?");
    }
    if (!s.doctorId) return this.respond("I'm sorry to hear that. Could you tell me a little more about your symptoms so I can find the right doctor?");
    if (s.hold) return this.respond('Your slot is on hold. Tap Done on the payment screen to confirm it.');
    return this.respond(this.offerTimes(s.doctorId));
  }

  offerTimes(doctorId) {
    const offered = this.freeSlots(doctorId).slice(0, 3);
    this.s.offeredSlotIds = offered.map((x) => x.id);
    const slots = offered.map((x) => x.label);
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
      s.awaiting = this.missingField() || 'confirm';
      this.applyState(res.state);
      const d = this.doctor(res.booking.doctorId);
      const held = source === 'assistant' ? '' : `Great, I'm holding ${d.short} for you, ${res.booking.range}. `;
      const next = s.awaiting === 'confirm'
        ? this.detailsWrapUp()
        : `To finish the booking I just need a few details. ${ASK[s.awaiting]}`;
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
    this.hooks.playClip('confirmed');
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
    this.hooks.playClip('emergency');

    if (s.hold) { await api.release(s.hold.id).catch(() => {}); s.hold = null; }
    const conversationId = await this.hooks.conversationId?.();
    const res = await api.emergency(emergencyDoctorFor(text || phrase), text || phrase, s.patient, { conversationId, specialty: detectSpecialty(text || ''), alertSource: source, alertPhrase: phrase });
    s.emergency = res.booking;
    s.displaced = res.displaced;
    s.doctorId = res.booking.doctorId;
    this.applyState(res.state);

    const d = this.doctor(res.booking.doctorId);
    const ask = s.awaiting ? ASK[s.awaiting] : '';
    this.respond(
      `This sounds like an emergency. If you're in danger right now, call emergency services, 911. I've reserved ${d.short}'s next same-day slot, ${res.booking.range}, for you. ${ask}`.trim(),
      { nudge: source !== 'model', kind: 'emergency' }
    );
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

  emergencyWrapUp() {
    const s = this.s;
    const b = s.emergency;
    if (!b) return 'Help is on the way. Stay with me.';
    const d = this.doctor(b.doctorId);
    const first = s.patient.name.split(' ')[0];
    return `Thank you${first ? `, ${first}` : ''}. ${d.name} is expecting you ${b.range}. Your emergency booking ID is ${b.id}, and the details are on your phone. If anything gets worse, call 911 immediately.`;
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
        const times = parseTimes(text);
        const slot = times.length === 1 ? matchSlot(times, this.freeSlots(s.doctorId)) : null;
        // Ava said she's holding a specific time: make the screen match.
        if (slot && isHoldAnnouncement(text)) {
          const askedDetail = /\b(?:name|address|phone)\b/i.test(text);
          return this.placeHold(slot.id, 'assistant', { nudge: !askedDetail });
        }
        if (slot) { s.proposedSlotId = slot.id; this.changed(); }
        const listed = times.map((x) => matchSlot([x], this.freeSlots(s.doctorId))).filter(Boolean);
        if (listed.length > 1) s.offeredSlotIds = listed.map((x) => x.id);
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
      'When the patient picks a time, say you are holding it for them and give the appointment as a 30-minute range (for example "11:00 AM to 11:30 AM today"); never mention how long the hold lasts. Then collect their full name, home address and phone number, one question at a time. Accept the address exactly as the patient says it: never ask for a city, province, postal code or unit. After all three are collected, do a final check: read them back in this form: "Just a final check: your name is ..., your address is ..., and your phone number is ... Is that all correct?" (phone as digits). If the patient corrects something, update it and read all three back again. Only when the patient says yes, tell them the payment screen is open and to tap Done to confirm (or Release hold for a different time); then stay quiet until the screen reports what they tapped. Never invent booking IDs, prices or times that are not listed below; the screen shows IDs.',
      'ADDRESS RULE: whatever the patient says for their address the first time is final, even if it is only a number, only a street, misheard or unusual. NEVER ask any follow-up about the address: no street name, house number, city, province, state, postal code, ZIP, unit, spelling or "full address". Never ask them to repeat or complete it. Acknowledge briefly and go straight to the phone number.',
      'EMERGENCIES: if the patient mentions chest pain, trouble breathing, stroke signs, heavy bleeding, fainting, a severe allergic reaction, suicidal thoughts, a baby with a fever, a head injury, poisoning, sudden confusion, severe abdominal pain, choking, a bone sticking out or a limb bent the wrong way, a bad burn, bleeding during pregnancy, or feeling like they are dying, or says it is urgent (but not "not urgent" or "urgent care"), say clearly: "This sounds like an emergency. If you are in danger, call emergency services, 911." Then tell them a same-day emergency slot has been reserved and collect their full name, home address and phone number, one at a time (never ask for city or postal code). Stay calm and reassuring.',
      '',
      'DOCTORS:',
      docs,
      '',
      'CURRENT STATE (from the clinic screen, always trust this):',
    ];

    if (s.mode === 'emergency') {
      const b = s.emergency;
      const d = b && this.doctor(b.doctorId);
      lines.push(`- EMERGENCY MODE. ${b ? `Emergency booking ${b.id} with ${d.name}, ${b.range} (payment waived).` : 'Reserving an emergency slot now.'}`);
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
    if (s.reply) lines.push('', `SUGGESTED NEXT LINE (adapt naturally): "${s.reply}"`);
    return lines.join('\n');
  }

  async reset() {
    this.s = fresh();
    this.resumeTranscript = [];
    this.applyState((await api.reset()));
  }
}
