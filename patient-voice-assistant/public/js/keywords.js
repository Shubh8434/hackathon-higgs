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
  /severe (?:pain|allergic|reaction|headache|burn|bleeding|chest)|anaphyla|throat (?:is )?(?:closing|swelling)|(?:bad|serious|strong) allergic reaction|(?:lips?|tongue|face) (?:is |are )?(?:swollen|swelling)/,
  // Baby/infant with a fever.
  /\b(?:baby|infant|newborn)\b.{0,40}\bfever|\bfever\b.{0,40}\b(?:baby|infant|newborn)\b/,
  /head injury|hit (?:my|his|her|their) head|banged (?:my|his|her|their) head|concussion|knocked out/,
  /poison\w*|swallowed (?:something|bleach|pills|a battery|batteries|a coin|chemicals)|drank (?:bleach|chemicals)/,
  /sudden(?:ly)? confus\w*|disoriented|doesn'?t know where (?:he|she|they) (?:is|are)/,
  /(?:severe|extreme|unbearable|terrible|excruciating) (?:abdominal|stomach|belly) pain|(?:abdominal|stomach|belly) pain (?:is )?(?:severe|unbearable|extreme|excruciating)/,
  /chok(?:ing|ed|es)\b/,
  /bone (?:is )?(?:sticking|poking) out|(?:arm|leg|wrist|ankle|finger) (?:is )?(?:bent|twisted|pointing) (?:the )?wrong (?:way|direction)|(?:open|compound) fractures?|dislocat(?:ed|ion|ions|ing)\b|popped out of (?:its |the )?socket/,
  /(?:bad|major|serious|big|third[- ]degree|second[- ]degree) burns?\b|burned (?:badly|my face|all over)|on fire/,
  /pregnan\w*.{0,40}\bbleed\w*|\bbleed\w*.{0,40}pregnan\w*/,
  /i'?m dying|(?:feel like|think) i'?m (?:going to die|dying)|going to die/,
  /\b(?:urgent|emergency|ambulance|911)\b/,
];

// Phrases that mean the *model* decided this is an emergency.
const MODEL_EMERGENCY = /call (?:emergency services|911|an ambulance)|emergency services|this (?:sounds|is|could be) (?:like )?(?:an |a medical )?emergency|emergency slot/;

const norm = (s) => String(s || '').toLowerCase().replace(/[’`]/g, "'");

// Blank out negated urgency so "it's not urgent", "this isn't an emergency",
// "no need for emergency services" and "urgent care" don't trigger.
const NEGATED = /\b(?:not|isn'?t|is not|wasn'?t|no|non-?|nothing|don'?t (?:think|need)|doesn'?t (?:seem|need)|no need for)\s+(?:(?:an?|really|very|that|super|too|it'?s|to call|to go to|any)\s+)*(?:urgent|emergency(?: services)?|severe|ambulance|911)\b|\burgent care\b|\bnon-?(?:urgent|emergency)\b/g;
const stripNegated = (t) => t.replace(NEGATED, ' ');

export function detectRedFlag(text) {
  const t = stripNegated(norm(text));
  for (const re of RED_FLAGS) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

export function detectModelEmergency(text) {
  const m = MODEL_EMERGENCY.exec(stripNegated(norm(text)));
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

// Who takes an emergency: child → pediatrics, chest/heart → cardiology,
// broken/dislocated bones → orthopedics, otherwise the GP triages.
export function emergencyDoctorFor(text) {
  const t = norm(text);
  if (SYMPTOM_MAP[0][1].test(t) || /\b(?:baby|infant|newborn)\b/.test(t)) return 'rahman';
  if (/chest|heart|palpitation/.test(t)) return 'chen';
  if (/bone (?:is )?(?:sticking|poking) out|fracture|dislocat\w*|out of (?:its |the )?socket|broken (?:arm|leg|bone|wrist|ankle|hip)|(?:bent|twisted|pointing) (?:the )?wrong/.test(t)) return 'kim';
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
// Dates: "today", "tomorrow", "day after tomorrow", "Monday", "next Friday",
// "October 28", "28th of October", "the 3rd", "next week". Resolved against
// `now` to a local ISO date ("YYYY-MM-DD"), never in the past.
// ---------------------------------------------------------------------------
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDate(text, now = Date.now()) {
  const t = norm(text);
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const plus = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return isoDate(d); };

  if (/\bday after tomorrow\b/.test(t)) return plus(2);
  if (/\btomorrow\b/.test(t)) return plus(1);
  if (/\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b/.test(t)) return plus(0);

  // "October 28", "Oct 28th", "28th of October", "28 October"
  const md = new RegExp(`\\b${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\b`).exec(t);
  const hit = md ? { mon: md[1], day: Number(md[2]) } : dm ? { mon: dm[2], day: Number(dm[1]) } : null;
  if (hit && hit.day >= 1 && hit.day <= 31) {
    const d = new Date(base.getFullYear(), MONTH_IDX[hit.mon.slice(0, 3)], hit.day);
    if (d < base) d.setFullYear(d.getFullYear() + 1);
    return isoDate(d);
  }

  // "the 3rd" → that day this month, or next month if it has passed
  const nth = /\bthe (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (nth && Number(nth[1]) <= 31) {
    const d = new Date(base.getFullYear(), base.getMonth(), Number(nth[1]));
    if (d < base) d.setMonth(d.getMonth() + 1);
    return isoDate(d);
  }

  // "Monday", "this Friday", "next Tuesday" → the next one after today
  const wd = new RegExp(`\\b(?:(next|this|on|coming) )?(${WEEKDAY_NAMES.join('|')})\\b`).exec(t);
  if (wd) {
    const target = WEEKDAY_NAMES.indexOf(wd[2]);
    let diff = (target - base.getDay() + 7) % 7;
    if (diff === 0) diff = wd[1] === 'this' ? 0 : 7;
    return plus(diff);
  }

  if (/\bnext week\b/.test(t)) return plus(((8 - base.getDay()) % 7) || 7); // next Monday
  return null;
}

// The one day a sentence is about, 'multi' if it names several days
// ("10 AM Monday or 2 PM Tuesday"), or null if it names none.
export function dayFocus(text, now = Date.now()) {
  const t = norm(text);
  const refs = new Set();
  for (const m of t.matchAll(new RegExp(`\\b(?:today|tomorrow|${WEEKDAY_NAMES.join('|')})\\b`, 'g'))) refs.add(m[0]);
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\.? \\d{1,2}`, 'g'))) refs.add(m[0]);
  const weekdays = [...refs].filter((r) => WEEKDAY_NAMES.includes(r));
  // "Thursday, Nov 5" is one day: a weekday plus its date.
  if (refs.size === 2 && weekdays.length === 1 && [...refs].some((r) => /\d/.test(r))) return parseDate(text, now);
  if (refs.size > 1) return 'multi';
  return refs.size ? parseDate(text, now) : null;
}

// "morning" | "afternoon" | null
export function parseDayPart(text) {
  const t = norm(text);
  if (/\bmorning\b|\bearly\b|\bbefore (?:noon|lunch)\b/.test(t)) return 'morning';
  if (/\bafternoon\b|\bafter (?:noon|lunch)\b|\blater in the day\b/.test(t)) return 'afternoon';
  return null;
}

// ---------------------------------------------------------------------------
// Times: "10:30", "10.30", "2 pm", "two thirty", "half past ten", "at 9",
// "11 o'clock", "noon". Returns [{ time: 'HH:MM', date: 'YYYY-MM-DD'|null }].
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

// "11:00 AM to 11:30 AM" is one appointment: drop the end of a range.
const RANGE_END = /(\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:to|until|till|-|–)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/g;

export function parseTimes(text, now = Date.now()) {
  const t = wordsToDigits(norm(text)).replace(RANGE_END, (m, start) => (/[:.]\d{2}|[ap]\.?m/.test(m) ? start : m));
  const date = parseDate(text, now);
  const out = [];
  const seen = new Set();
  const push = (h, m, ampm) => {
    const time = to24(Number(h), Number(m || 0), ampm && ampm.replace(/\./g, ''));
    if (time && !seen.has(time)) { seen.add(time); out.push({ time, date }); }
  };
  const AMPM = '(a\\.?m\\.?|p\\.?m\\.?)';
  const patterns = [
    new RegExp(`\\b(\\d{1,2})[:.](\\d{2})\\s*${AMPM}?`, 'g'),
    new RegExp(`(?<![:.\\d])(\\d{1,2})\\s*${AMPM}`, 'g'), // not the "00 am" inside "11:00 am"
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

// "after 3 pm", "later than 2", "from 2:30", "before 11", "no later than 10"
// → { kind: 'after' | 'from' | 'before', time: 'HH:MM' }. A constraint, not a pick.
export function parseTimeConstraint(text) {
  const t = wordsToDigits(norm(text));
  const m = /\b(after|later than|from|before|earlier than|no later than|by)\s+(\d{1,2}(?:[:.]\d{2})?)\s*(a\.?m\.?|p\.?m\.?)?(?!\s*(?:days?|weeks?|months?|years?|hours?|minutes?|mins?)\b)/.exec(t);
  if (!m) return null;
  const [h, mm = '0'] = m[2].split(/[:.]/);
  const time = to24(Number(h), Number(mm), m[3] && m[3].replace(/\./g, ''));
  if (!time) return null;
  const kind = /^(after|later than)$/.test(m[1]) ? 'after' : m[1] === 'from' ? 'from' : 'before';
  return { kind, time };
}

// A question about availability ("do you have…?", "is 3 open?") rather than a choice.
export function isQuestion(text) {
  const t = norm(text).trim();
  return /\?$/.test(t) || /^(?:do|does|is|are|any|anything|can|could|would|have you got|what about|how about|is there)\b/.test(t);
}

// Pick the open slot matching a spoken time: on the spoken date if given,
// otherwise the soonest one (slots are sorted soonest first).
export function matchSlot(times, freeSlots) {
  for (const { time, date } of times) {
    const hit = freeSlots.find((s) => s.time === time && (!date || s.date === date));
    if (hit) return hit;
  }
  return null;
}

// "The first one", "second", "the last option", "earliest" → index into the
// offered times (-1 = last). Null when no choice is expressed.
const CHOICES = [
  [/\b(?:first|1st|earliest|soonest)\b/, 0],
  [/\b(?:second|2nd|middle)\b/, 1],
  [/\b(?:third|3rd)\b/, 2],
  [/\b(?:last|latest)\b/, -1],
];

export function parseChoice(text) {
  const t = norm(text);
  for (const [re, i] of CHOICES) if (re.test(t)) return i;
  return null;
}

// Assistant says it has put a hold on / reserved a time.
export function isHoldAnnouncement(text) {
  return /\b(?:holding|hold(?:ing)? (?:it|that|the)|on hold|reserv(?:ed|ing)|booked you|put you down|got you down|have you down|booking you)\b/.test(norm(text));
}

// ---------------------------------------------------------------------------
// Conversation intents
// ---------------------------------------------------------------------------
export function isConfirmation(text) {
  const t = norm(text);
  if (/\b(?:no|nope|not|don'?t|another|different|other|wrong|incorrect|change|fix)\b/.test(t)) return false;
  return /\b(?:yes|yeah|yep|yup|ya|sure|okay|ok|sounds good|that works|works for me|perfect|book it|go ahead|please do|confirm|let'?s do (?:it|that)|great|correct|that'?s right|right|all good|looks good|exactly|uh[- ]?huh|mm[- ]?hmm)\b/.test(t);
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

export function formatPhone(digits) {
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

export function extractPhone(text) {
  const t = norm(text).replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => String(DIGIT_WORDS[w]));
  // "5 5 5 1 2 3 4" or "555-123-4567" or "(416) 555 0199" or "8 4 3, 4 6 2, ..."
  const m = /(\+?\d[\d\s().,-]{5,}\d)/.exec(t);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return formatPhone(digits);
}

// Every digit in a reply to "what's your phone number?", including STT
// homophones ("for" → 4, "to" → 2). Used to stitch a number spoken in pieces.
const PHONE_WORDS = { ...DIGIT_WORDS, for: 4, to: 2, too: 2, ate: 8, won: 1 };
export function phoneDigits(text) {
  return norm(text)
    .replace(/\b(zero|oh|o|one|won|two|to|too|three|four|for|five|six|seven|eight|ate|nine)\b/g, (w) => String(PHONE_WORDS[w]))
    .replace(/\D/g, '');
}

const STREET = '(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|crescent|cres|terrace|parkway|pkwy|highway|hwy|circle|square)';

// "One, two, three Main Street" → "123 Main Street".
function digitRuns(s) {
  const W = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
  return s.replace(new RegExp(`\\b${W}(?:[\\s,-]+${W})*\\b`, 'gi'),
    (run) => run.split(/[\s,-]+/).map((w) => DIGIT_WORDS[w.toLowerCase()]).join(''));
}

const ADDRESS_LEAD = /^(?:(?:um+|uh+|so|okay|ok|yeah|yes|well|sure|sorry)[,.\s]+)*(?:(?:i think|i guess|i believe)\s+)?(?:(?:it'?s|it is|that'?s|that is|my (?:home )?address is|my address'?s|the address is|address is|address|i live at|i live on|i'?m at|i am at|we'?re at|we are at|located at)[:,\s]+)?/i;

// Just the address the patient said: no lead-in words, digit words as digits.
export function cleanAddress(text) {
  return digitRuns(String(text || ''))
    .replace(ADDRESS_LEAD, '')
    .replace(/[.!?]+\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?]+$/, '');
}

export function extractAddress(text) {
  const raw = digitRuns(String(text || ''));
  const lead = /\b(?:i live at|i live on|my address is|address is|the address is|i'?m at|i am at|located at|we'?re at|we are at|come to)\s+(.+?)(?:[.!?]\s|,?\s+and\s+my\b|,\s*(?:and\s+)?(?:my|phone|number|i|it'?s)\b|[.!?]?$)/i.exec(raw);
  if (lead && /\d/.test(lead[1])) return cleanAddress(lead[1]);
  const street = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Za-z0-9'.-]+\\s+){1,4}${STREET}\\b\\.?(?:,?\\s*(?:apt|apartment|unit|suite)\\.?\\s*\\w+)?(?:,\\s*[A-Za-z .]+)?`, 'i').exec(raw);
  if (street) return cleanAddress(street[0]);
  return lead ? cleanAddress(lead[1]) : null;
}

const NOT_NAMES = new Set(['having', 'feeling', 'in', 'not', 'at', 'okay', 'ok', 'fine', 'scared', 'sorry', 'calling', 'here', 'the', 'a', 'so', 'really', 'very', 'just', 'going', 'trying', 'bleeding', 'dizzy', 'sick', 'hurt', 'worried']);

function titleCase(s) {
  return s.replace(/\b([a-z])([a-z'-]*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase());
}

// Title-cased name without leading fillers ("ah Subham" → "Subham").
function cleanName(s) {
  return titleCase(String(s).replace(/^(?:(?:ah+|uh+|um+|er+|hmm+|oh|so|well|okay|ok|yeah|yes|myself|this is|it'?s|i'?m)\b[\s,.]*)+/i, '').trim());
}

export function extractName(text, { expecting = false } = {}) {
  const raw = String(text || '').trim();
  const m = /\b(?:my name is|my name's|name is|this is|myself|i am|i'm|it's|call me)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})/i.exec(raw);
  if (m) {
    const words = m[1].split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
    // Cut at the first filler word so "I'm John and..." → "John".
    const cut = [];
    for (const w of m[1].split(/\s+/)) {
      if (NOT_NAMES.has(w.toLowerCase()) || /^(and|but|i|my)$/i.test(w)) break;
      cut.push(w);
    }
    if (cut.length && words.length) return cleanName(cut.join(' '));
  }
  // Answer to "What's your name?" → accept a short bare reply like "John Smith."
  if (expecting) {
    const bare = raw.replace(/[.,!?]/g, '').trim();
    const words = bare.split(/\s+/);
    const numeric = (w) => /^(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten)$/i.test(w);
    if (words.length >= 1 && words.length <= 4 && words.every((w) => /^[a-z'-]+$/i.test(w) && !NOT_NAMES.has(w.toLowerCase()) && !numeric(w))) {
      return cleanName(bare) || null;
    }
  }
  return null;
}

export function extractDetails(text, expecting = null) {
  const out = {};
  const phone = extractPhone(text);
  if (phone) out.phone = phone;
  // A plain answer to "what's your address?" is kept whole, minus lead-in words.
  const bare = expecting === 'address' && !phone && !/\bmy name\b/i.test(text) ? cleanAddress(text) : '';
  let address = bare.split(/\s+/).length >= 2 ? bare : extractAddress(text);
  // Asked for a name but got something with numbers in it: that's the address.
  if (!address && expecting === 'name' && !phone) {
    const guess = cleanAddress(text);
    if (/\d/.test(guess) && guess.split(/\s+/).length >= 2) address = guess;
  }
  if (address) out.address = address;
  // While asking for address/phone, only an explicit "my name is" changes the
  // name ("it's 12 Main St" must not become a name).
  const explicitOnly = out.address || out.phone || (expecting && expecting !== 'name');
  if (!explicitOnly || /\bmy name(?: is|'s)\b/i.test(text)) {
    const name = extractName(text, { expecting: expecting === 'name' && !out.address && !out.phone });
    if (name) out.name = name;
  }
  return out;
}

// Ava reading details back ("Your name is X, your address is Y, and your
// phone number is Z"). The model hears the audio directly, so its read-back is
// usually cleaner than the raw patient transcript.
export function extractReadback(text) {
  const raw = String(text || '');
  const out = {};
  const name = /\byour (?:full )?name is ([^,.;]+)/i.exec(raw);
  if (name && name[1].trim().split(/\s+/).length <= 4) out.name = cleanName(name[1].trim());
  const address = /\byour (?:home )?address is (.+?)(?:,? and your\b|, your\b|\.\s|\.?$)/i.exec(raw);
  if (address) out.address = cleanAddress(address[1]);
  const phone = extractPhone(raw);
  if (phone) out.phone = phone;
  return out;
}

// Ava asking a follow-up about an address the patient already gave (street
// name, house number, city, postal code, unit, "full address"…). Her read-back
// ("your address is …") is not a follow-up.
export function isAddressFollowUp(text) {
  const t = norm(text);
  if (/\byour (?:home )?address is\b|\bfinal check\b/.test(t)) return false;
  if (/\b(?:city|province|postal code|postcode|zip code)\b/.test(t)) return true;
  return /\?/.test(t) && /\b(?:street name|name of (?:the|your) street|which street|what street|street number|house number|building number|unit|apartment|apt|suite|full address|complete address|exact address|whole address|more (?:details|specific) (?:about|on|for) (?:the|your|that) address|spell (?:that|the street|it))\b/.test(t);
}

// Ava telling the patient the details are ready and to tap Done.
export function isPayPrompt(text) {
  const t = norm(text);
  return /\btap done\b|\bpayment screen\b/.test(t) && /\b(?:check|details|confirm)/.test(t);
}

// ---------------------------------------------------------------------------
// Caption highlighting → [{ text, cls }] where cls is 'kw-red' | 'kw-amber' |
// 'kw-blue' | null. Red > amber > blue when patterns compete.
// ---------------------------------------------------------------------------
const HL_RED = "call emergency services|emergency services|call 911|911|emergency|ambulance|severe(?:ly)?|urgent(?:ly)?|chest pain|chest pressure|can'?t breathe|cannot breathe|short(?:ness)? of breath|trouble breathing|difficulty breathing|heart attack|stroke|seizure|unconscious|passed out|bleeding|immediately|right away|life[- ]threatening|head injury|concussion|poison(?:ed|ing)?|choking|dislocat(?:ed|ions?)|disoriented|overdose";
const HL_AMBER = "credit card|co-?pay|payment|payments|paying|paid|pay|card|fees?|costs?|price|charged?|receipt|insurance|billing|invoice|deposit|refund|done button";
const HL_BLUE = "(?:Dr\\.?|Doctor) (?:(?:Sarah|James|Maria|David|Aisha) )?(?:Patel|Chen|Lopez|Kim|Rahman)|Patel|Chen|Lopez|Kim|Rahman|\\d{1,2}[:.]\\d{2}(?:\\s*[ap]\\.?m\\b\\.?)?|\\d{1,2}\\s*[ap]\\.?m\\b\\.?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: thirty| o'?clock)|half past \\w+|noon|today|tomorrow|this morning|this afternoon|o'?clock|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.? \\d{1,2}(?:st|nd|rd|th)?";

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
