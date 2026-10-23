// Keyword heuristics: red-flag safety net, symptom → specialty map, doctor and
// time parsing, emergency detail capture, and caption highlighting.
// Pure functions (no DOM) so they can be unit-tested with `node --test`.

// ---------------------------------------------------------------------------
// Red flags (STT safety net). Matched against the patient's live transcript;
// any hit forces the emergency flow even if the model didn't flag it.
// ---------------------------------------------------------------------------
const RED_FLAGS = [
  /chest (?:pain|pressure|tightness|hurts)|pain in (?:my|the) chest|my chest (?:hurts|is tight)/,
  /can'?t breathe|cannot breathe|can not breathe|unable to breathe|(?:trouble|difficulty|struggling) breathing|short(?:ness)? of breath|not breathing|hard to breathe/,
  /heart attack|stroke|seizure|unconscious|passed out|fainted|unresponsive|not responding|collapsed/,
  /bleeding (?:heavily|a lot|badly|won'?t stop|that won'?t stop)|(?:heavy|severe) bleeding|coughing (?:up )?blood|vomiting blood/,
  /face (?:is )?drooping|slurred speech|(?:sudden )?numbness (?:on|in) (?:one|my left|my right)/,
  /suicid|kill myself|end my life|overdos/,
  /severe (?:pain|allergic|reaction|headache|burn|bleeding|chest)|anaphyla|throat (?:is )?(?:closing|swelling)|allergic reaction/,
  /\b(?:urgent|emergency|ambulance|911)\b/,
];

// Phrases that mean the *model* decided this is an emergency.
const MODEL_EMERGENCY = /call (?:emergency services|911|an ambulance)|emergency services|this (?:sounds|is|could be) (?:like )?(?:an |a medical )?emergency|emergency slot/;

const norm = (s) => String(s || '').toLowerCase().replace(/[’`]/g, "'");

export function detectRedFlag(text) {
  const t = norm(text);
  for (const re of RED_FLAGS) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

export function detectModelEmergency(text) {
  const m = MODEL_EMERGENCY.exec(norm(text));
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Symptom keyword map → specialty → doctor
// ---------------------------------------------------------------------------
export const SYMPTOM_MAP = [
  ['pediatrics', /\bmy (?:son|daughter|child|kid|baby|toddler|boy|girl)\b|\b(?:infant|newborn|children|pediatric)\b/],
  ['cardiology', /\b(?:chest|heart|palpitations?|blood pressure|hypertension|cholesterol|ecg|ekg|cardio\w*)\b/],
  ['dermatology', /\b(?:rash|skin|acne|itch\w*|mole|eczema|psoriasis|hives|sunburn|warts?|dermat\w*)\b/],
  ['orthopedics', /\b(?:back pain|knee|joints?|bones?|sprain\w*|fracture\w*|broken|shoulder|hip|ankle|wrist|neck pain|muscle|ortho\w*)\b/],
  ['general', /\b(?:check ?-?up|physical|fever|cold|flu|cough\w*|sore throat|headache|stomach|nausea|tired|fatigue|routine|vaccin\w*|ear ?ache|sinus|allerg\w*|sick|unwell|pain)\b/],
];

export const SPECIALTY_DOCTOR = {
  general: 'patel', cardiology: 'chen', dermatology: 'lopez', orthopedics: 'kim', pediatrics: 'rahman',
};

export function detectSpecialty(text) {
  const t = norm(text);
  for (const [spec, re] of SYMPTOM_MAP) if (re.test(t)) return spec;
  return null;
}

// Who takes an emergency: chest/heart → cardiology, child → pediatrics,
// otherwise the GP triages.
export function emergencyDoctorFor(text) {
  const t = norm(text);
  if (SYMPTOM_MAP[0][1].test(t)) return 'rahman';
  if (/chest|heart|palpitation/.test(t)) return 'chen';
  return 'patel';
}

// ---------------------------------------------------------------------------
// Doctors (with common STT misspellings)
// ---------------------------------------------------------------------------
const DOCTOR_ALIASES = {
  patel: ['patel', 'pattel', 'patell', 'sarah'],
  chen: ['chen', 'chan', 'chin', 'cheng', 'james'],
  lopez: ['lopez', 'lopes', 'maria'],
  kim: ['kim', 'david'],
  rahman: ['rahman', 'raman', 'rehman', 'rahmon', 'aisha'],
};

export function detectDoctor(text) {
  const t = norm(text);
  for (const [id, names] of Object.entries(DOCTOR_ALIASES)) {
    // First names only count with a title ("Dr. Sarah"); last names count alone.
    const [last, ...rest] = names;
    const lastRe = new RegExp(`\\b(?:${[last, ...rest.filter((n) => !/^(sarah|james|maria|david|aisha)$/.test(n))].join('|')})\\b`);
    const firstRe = new RegExp(`\\b(?:dr\\.?|doctor) (?:${rest.join('|')})\\b`);
    if (lastRe.test(t) || (rest.length && firstRe.test(t))) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Times: "10:30", "10.30", "2 pm", "two thirty", "half past ten", "at 9",
// "11 o'clock", "noon". Returns [{ time: 'HH:MM', day: 'today'|'tomorrow'|null }].
// ---------------------------------------------------------------------------
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function wordsToDigits(t) {
  return t
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => String(NUM_WORDS[w]))
    .replace(/\bnoon\b/g, '12:00 pm')
    .replace(/\bhalf past (\d{1,2})\b/g, '$1:30')
    .replace(/\b(\d{1,2}) thirty\b/g, '$1:30')
    .replace(/\b(\d{1,2}) o'?clock\b/g, '$1:00');
}

function to24(h, m, ampm) {
  let hour = h;
  if (ampm) {
    const pm = ampm.startsWith('p');
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  } else if (hour >= 1 && hour <= 7) {
    hour += 12; // clinic hours: a bare "2" means 2 PM
  }
  if (hour > 23 || m > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function parseTimes(text) {
  const t = wordsToDigits(norm(text));
  const day = /\btomorrow\b/.test(t) ? 'tomorrow' : /\btoday\b|\bthis (?:morning|afternoon)\b/.test(t) ? 'today' : null;
  const out = [];
  const seen = new Set();
  const push = (h, m, ampm) => {
    const time = to24(Number(h), Number(m || 0), ampm && ampm.replace(/\./g, ''));
    if (time && !seen.has(time)) { seen.add(time); out.push({ time, day }); }
  };
  const AMPM = '(a\\.?m\\.?|p\\.?m\\.?)';
  const patterns = [
    new RegExp(`\\b(\\d{1,2})[:.](\\d{2})\\s*${AMPM}?`, 'g'),
    new RegExp(`\\b(\\d{1,2})\\s*${AMPM}`, 'g'),
    /\b(?:at|around|for|by) (\d{1,2})\b(?![:.\d]| ?(?:minutes?|mins?|hours?|days?|years?|weeks?))/g,
  ];
  const hits = [];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      if (re === patterns[0]) hits.push([m.index, m[1], m[2], m[3]]);
      else if (re === patterns[1]) hits.push([m.index, m[1], 0, m[2]]);
      else hits.push([m.index, m[1], 0, null]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  for (const [, h, m, ampm] of hits) push(h, m, ampm);
  return out;
}

// Pick the free slot matching a spoken time (prefers the spoken day, then today).
export function matchSlot(times, freeSlots) {
  for (const { time, day } of times) {
    const candidates = freeSlots.filter((s) => s.time === time && (!day || s.day === day));
    if (candidates.length) return candidates.find((s) => s.day === 'today') || candidates[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversation intents
// ---------------------------------------------------------------------------
export function isConfirmation(text) {
  const t = norm(text);
  if (/\b(?:no|nope|not really|don'?t|another|different|other)\b/.test(t)) return false;
  return /\b(?:yes|yeah|yep|yup|sure|okay|ok|sounds good|that works|works for me|perfect|book it|go ahead|please do|confirm|let'?s do (?:it|that)|great)\b/.test(t);
}

export function isBookingIntent(text) {
  return /\b(?:book|appointment|schedule|see (?:a|the) doctor|check ?-?up|visit|consult)\b/.test(norm(text));
}

export function isPaymentDone(text) {
  return /\b(?:i'?ve paid|i paid|paid|payment (?:is )?done|done paying|i'?m done|tapped done|pressed done|clicked done)\b/.test(norm(text));
}

// ---------------------------------------------------------------------------
// Emergency detail capture (name, address, phone)
// ---------------------------------------------------------------------------
const DIGIT_WORDS = { zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

export function extractPhone(text) {
  const t = norm(text).replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => String(DIGIT_WORDS[w]));
  // "5 5 5 1 2 3 4" or "555-123-4567" or "(416) 555 0199"
  const m = /(\+?\d[\d\s().-]{5,}\d)/.exec(t);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

const STREET = '(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|crescent|cres|terrace|parkway|pkwy|highway|hwy|circle|square)';

export function extractAddress(text) {
  const raw = String(text || '');
  const lead = /\b(?:i live at|my address is|address is|the address is|i'?m at|i am at|located at|we'?re at|we are at|come to)\s+(.+?)(?:[.!?]\s|[.!?]?$)/i.exec(raw);
  if (lead && /\d/.test(lead[1])) return lead[1].trim().replace(/[.,]$/, '');
  const street = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Za-z0-9'.-]+\\s+){1,4}${STREET}\\b\\.?(?:,?\\s*(?:apt|apartment|unit|suite)\\.?\\s*\\w+)?(?:,\\s*[A-Za-z .]+)?`, 'i').exec(raw);
  if (street) return street[0].trim().replace(/[.,]$/, '');
  return lead ? lead[1].trim().replace(/[.,]$/, '') : null;
}

const NOT_NAMES = new Set(['having', 'feeling', 'in', 'not', 'at', 'okay', 'ok', 'fine', 'scared', 'sorry', 'calling', 'here', 'the', 'a', 'so', 'really', 'very', 'just', 'going', 'trying', 'bleeding', 'dizzy', 'sick', 'hurt', 'worried']);

function titleCase(s) {
  return s.replace(/\b([a-z])([a-z'-]*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase());
}

export function extractName(text, { expecting = false } = {}) {
  const raw = String(text || '').trim();
  const m = /\b(?:my name is|my name's|name is|this is|i am|i'm|it's|call me)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})/i.exec(raw);
  if (m) {
    const words = m[1].split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
    // Cut at the first filler word so "I'm John and..." → "John".
    const cut = [];
    for (const w of m[1].split(/\s+/)) {
      if (NOT_NAMES.has(w.toLowerCase()) || /^(and|but|i|my)$/i.test(w)) break;
      cut.push(w);
    }
    if (cut.length && words.length) return titleCase(cut.join(' '));
  }
  // Answer to "What's your name?" → accept a short bare reply like "John Smith."
  if (expecting) {
    const bare = raw.replace(/[.,!?]/g, '').trim();
    const words = bare.split(/\s+/);
    if (words.length >= 1 && words.length <= 4 && words.every((w) => /^[a-z'-]+$/i.test(w) && !NOT_NAMES.has(w.toLowerCase()))) {
      return titleCase(bare);
    }
  }
  return null;
}

export function extractDetails(text, expecting = null) {
  const out = {};
  const phone = extractPhone(text);
  if (phone) out.phone = phone;
  const address = extractAddress(text);
  if (address) out.address = address;
  else if (expecting === 'address' && String(text).trim().split(/\s+/).length >= 2 && !phone) {
    out.address = String(text).trim().replace(/[.!?]$/, '');
  }
  if (!out.address && !out.phone) {
    const name = extractName(text, { expecting: expecting === 'name' });
    if (name) out.name = name;
  } else {
    const name = extractName(text);
    if (name) out.name = name;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caption highlighting → [{ text, cls }] where cls is 'kw-red' | 'kw-amber' |
// 'kw-blue' | null. Red > amber > blue when patterns compete.
// ---------------------------------------------------------------------------
const HL_RED = "call emergency services|emergency services|call 911|911|emergency|ambulance|severe(?:ly)?|urgent(?:ly)?|chest pain|chest pressure|can'?t breathe|cannot breathe|short(?:ness)? of breath|trouble breathing|difficulty breathing|heart attack|stroke|seizure|unconscious|passed out|bleeding|immediately|right away|life[- ]threatening";
const HL_AMBER = "credit card|co-?pay|payment|payments|paying|paid|pay|card|fees?|costs?|price|charged?|receipt|insurance|billing|invoice|deposit|refund|done button";
const HL_BLUE = "(?:Dr\\.?|Doctor) (?:(?:Sarah|James|Maria|David|Aisha) )?(?:Patel|Chen|Lopez|Kim|Rahman)|Patel|Chen|Lopez|Kim|Rahman|\\d{1,2}[:.]\\d{2}(?:\\s*[ap]\\.?m\\b\\.?)?|\\d{1,2}\\s*[ap]\\.?m\\b\\.?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: thirty| o'?clock)|half past \\w+|noon|today|tomorrow|this morning|this afternoon|o'?clock";

const HL_RE = new RegExp(`(\\b(?:${HL_RED})\\b)|(\\b(?:${HL_AMBER})\\b|\\$\\d+(?:\\.\\d{2})?)|(\\b(?:${HL_BLUE})\\b)`, 'gi');

export function highlightSegments(text) {
  const src = String(text || '');
  const out = [];
  let last = 0;
  for (const m of src.matchAll(HL_RE)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), cls: null });
    out.push({ text: m[0], cls: m[1] ? 'kw-red' : m[2] ? 'kw-amber' : 'kw-blue' });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: null });
  return out;
}
