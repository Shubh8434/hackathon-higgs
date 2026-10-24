import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRedFlag, detectModelEmergency, detectSpecialty, detectDoctor, emergencyDoctorFor,
  parseTimes, matchSlot, isConfirmation, isBookingIntent, extractPhone, extractAddress,
  extractName, extractDetails, highlightSegments, parseChoice, isHoldAnnouncement, extractReadback, isPayPrompt, phoneDigits,
} from '../public/js/keywords.js';

test('red flags: demo phrases trigger, routine ones do not', () => {
  assert.ok(detectRedFlag('I have severe chest pain and shortness of breath'));
  assert.ok(detectRedFlag('I have chest pain'));
  assert.ok(detectRedFlag("It's urgent"));
  assert.ok(detectRedFlag("I can't breathe"));
  assert.ok(detectRedFlag('I can’t breathe')); // curly apostrophe from STT
  assert.equal(detectRedFlag("I'd like to book a routine checkup"), null);
  assert.equal(detectRedFlag('Book me a normal appointment'), null);
  assert.equal(detectRedFlag('I have a rash on my arm'), null);
});

test('model emergency phrases', () => {
  assert.ok(detectModelEmergency('Please call emergency services right now.'));
  assert.ok(detectModelEmergency('This sounds like an emergency.'));
  assert.equal(detectModelEmergency('Dr. Chen has a 10 AM opening.'), null);
});

test('symptom map → specialty', () => {
  assert.equal(detectSpecialty("I'd like to book a routine checkup"), 'general');
  assert.equal(detectSpecialty('My heart has been racing'), 'cardiology');
  assert.equal(detectSpecialty('I have an itchy rash'), 'dermatology');
  assert.equal(detectSpecialty('My knee hurts when I run'), 'orthopedics');
  assert.equal(detectSpecialty('My daughter has a fever'), 'pediatrics');
  assert.equal(detectSpecialty('Book me a normal appointment'), null);
});

test('emergency doctor routing', () => {
  assert.equal(emergencyDoctorFor('severe chest pain'), 'chen');
  assert.equal(emergencyDoctorFor("my son can't breathe"), 'rahman');
  assert.equal(emergencyDoctorFor("It's urgent"), 'patel');
});

test('doctor detection incl. STT misspellings', () => {
  assert.equal(detectDoctor('Can I see Dr. Patel?'), 'patel');
  assert.equal(detectDoctor('doctor chan please'), 'chen');
  assert.equal(detectDoctor('Raman is fine'), 'rahman');
  assert.equal(detectDoctor('Doctor Maria'), 'lopez');
  assert.equal(detectDoctor('I am Sarah'), null);
  assert.equal(detectDoctor('nothing here'), null);
});

test('time parsing', () => {
  assert.deepEqual(parseTimes('10:30 works'), [{ time: '10:30', day: null }]);
  assert.deepEqual(parseTimes('how about 2 pm tomorrow'), [{ time: '14:00', day: 'tomorrow' }]);
  assert.deepEqual(parseTimes('two thirty today'), [{ time: '14:30', day: 'today' }]);
  assert.deepEqual(parseTimes('half past nine'), [{ time: '09:30', day: null }]);
  assert.deepEqual(parseTimes("eleven o'clock"), [{ time: '11:00', day: null }]);
  assert.deepEqual(parseTimes('at 3'), [{ time: '15:00', day: null }]);
  assert.deepEqual(parseTimes('hold it for 5 minutes'), []);
  assert.deepEqual(parseTimes('10 a.m.'), [{ time: '10:00', day: null }]);
});

test('matchSlot prefers spoken day, then today', () => {
  const free = [
    { id: 'a', day: 'today', time: '10:00' },
    { id: 'b', day: 'tomorrow', time: '10:00' },
    { id: 'c', day: 'tomorrow', time: '14:00' },
  ];
  assert.equal(matchSlot(parseTimes('10 am'), free).id, 'a');
  assert.equal(matchSlot(parseTimes('10 am tomorrow'), free).id, 'b');
  assert.equal(matchSlot(parseTimes('2pm'), free).id, 'c');
  assert.equal(matchSlot(parseTimes('9am'), free), null);
});

test('intents', () => {
  assert.ok(isConfirmation('Yes, that works'));
  assert.ok(!isConfirmation('No, a different time'));
  assert.ok(isBookingIntent('Book me a normal appointment'));
});

test('emergency detail extraction', () => {
  assert.equal(extractPhone('my number is 416 555 0199'), '(416) 555-0199');
  assert.equal(extractPhone('four one six five five five zero one nine nine'), '(416) 555-0199');
  assert.equal(extractPhone('I am 42'), null);
  assert.equal(extractAddress('I live at 221 King Street West, Toronto.'), '221 King Street West, Toronto');
  assert.equal(extractAddress('It is 12 Maple Ave'), '12 Maple Ave');
  assert.equal(extractName('My name is John Smith'), 'John Smith');
  assert.equal(extractName("I'm having chest pain"), null);
  assert.equal(extractName('john smith', { expecting: true }), 'John Smith');
  assert.deepEqual(extractDetails('My name is Ana Diaz and my number is 647-555-0123', null), { phone: '(647) 555-0123', name: 'Ana Diaz' });
  assert.deepEqual(extractDetails('22 Queen Street', 'address'), { address: '22 Queen Street' });
});

test('caption highlighting colors', () => {
  const segs = highlightSegments('Dr. Chen at 10:30 today. Payment is $40. Call emergency services if severe.');
  const by = (cls) => segs.filter((s) => s.cls === cls).map((s) => s.text);
  assert.deepEqual(by('kw-blue'), ['Dr. Chen', '10:30', 'today']);
  assert.deepEqual(by('kw-amber'), ['Payment', '$40']);
  assert.deepEqual(by('kw-red'), ['Call emergency services', 'severe']);
  assert.equal(segs.map((s) => s.text).join(''), 'Dr. Chen at 10:30 today. Payment is $40. Call emergency services if severe.');
});

test('slot choice: ordinals map to offered-time indexes', () => {
  assert.equal(parseChoice('The first one please'), 0);
  assert.equal(parseChoice('earliest is fine'), 0);
  assert.equal(parseChoice("I'll take the second"), 1);
  assert.equal(parseChoice('third option'), 2);
  assert.equal(parseChoice('the last one'), -1);
  assert.equal(parseChoice('10:30 tomorrow works'), null);
});

test('hold announcement: assistant reserving a time', () => {
  assert.ok(isHoldAnnouncement("Great, I'm holding 10:30 AM tomorrow for you for 5 minutes."));
  assert.ok(isHoldAnnouncement("I've reserved 10 AM today with Dr. Patel."));
  assert.equal(isHoldAnnouncement('Open times are 10 AM, 10:30 AM or 11 AM today.'), false);
});

test('address: stops before a following phone/name clause', () => {
  assert.equal(extractAddress('My name is Ana Diaz, I live at 22 Queen Street, my number is 647 555 0123'), '22 Queen Street');
  assert.equal(extractAddress('I live at 5 King Road, Toronto and my phone is 555 1234'), '5 King Road, Toronto');
});

test('read-back: details from Ava override the raw transcript', () => {
  const t = 'Your name is Subham Sharma, your address is Street East 123 in Toronto, Ontario, and your phone number is 843-462-8540. Is that all right?';
  assert.deepEqual(extractReadback(t), { name: 'Subham Sharma', address: 'Street East 123 in Toronto, Ontario', phone: '(843) 462-8540' });
  assert.equal(extractPhone('Eight four three, four six two, eight five four zero'), '(843) 462-8540');
  assert.equal(extractName('Eight four three', { expecting: true }), null);
  assert.ok(isPayPrompt('Please check those details on your screen and tap Done on the payment screen.'));
});

test('address: only the address, no lead-in wording', () => {
  assert.equal(extractDetails('My address is 123 Street East', 'address').address, '123 Street East');
  assert.equal(extractDetails("I think it's Street East. One, two, three", 'address').address, 'Street East 123');
  assert.equal(extractDetails("Um, it's 45 Bloor Street West.", 'address').address, '45 Bloor Street West');
  assert.equal(extractDetails('I live at 22 Queen Street', 'address').address, '22 Queen Street');
  assert.equal(extractDetails("It's 12 Main Street", 'address').name, undefined);
});

test('names: leading fillers are dropped', () => {
  assert.equal(extractName('Ah Subham Sharma', { expecting: true }), 'Subham Sharma');
  assert.equal(extractName('um', { expecting: true }), null);
  assert.equal(extractReadback('Your name is Ah Subham, your address is 1 King Street.').name, 'Subham');
});

test('red flags: added emergencies trigger', () => {
  for (const p of [
    'My baby has a high fever', 'the newborn is running a fever', 'I hit my head and feel dizzy', 'he might have a concussion',
    'my son swallowed a battery', 'I think she was poisoned', 'my dad is suddenly confused', 'she seems disoriented',
    'I have severe stomach pain', 'unbearable abdominal pain', 'my child is choking', 'the bone is sticking out',
    'his arm is bent the wrong way', 'I dislocated my shoulder', 'I have a bad burn on my hand', 'third-degree burns',
    "I'm pregnant and bleeding", 'I feel like I\'m dying', 'my lips are swelling', 'a bad allergic reaction',
  ]) assert.ok(detectRedFlag(p), p);
});

test('red flags: negated urgency and mild phrases do not trigger', () => {
  for (const p of [
    "It's not urgent", 'This is not an emergency', "it isn't an emergency, just a checkup", "it's nothing urgent",
    'Should I go to urgent care?', 'non-urgent appointment please', 'I had a mild allergic reaction last year',
    "I don't need an ambulance", 'my stomach hurts a bit',
  ]) assert.equal(detectRedFlag(p), null, p);
  assert.equal(detectModelEmergency("You don't need emergency services, this isn't an emergency."), null);
  assert.ok(detectRedFlag("it's not urgent but I have chest pain"));
});

test('emergency routing: bones → Kim, babies → Rahman', () => {
  assert.equal(emergencyDoctorFor('the bone is sticking out of my leg'), 'kim');
  assert.equal(emergencyDoctorFor('I dislocated my shoulder'), 'kim');
  assert.equal(emergencyDoctorFor('My baby has a high fever'), 'rahman');
  assert.equal(emergencyDoctorFor('I have severe stomach pain'), 'patel');
  assert.equal(emergencyDoctorFor('chest pain'), 'chen');
});

test('times: a spoken 30-minute range is one appointment time', () => {
  assert.deepEqual(parseTimes("Great, I'm holding Dr. Kim for you, 11:00 AM to 11:30 AM today."), [{ time: '11:00', day: 'today' }]);
  assert.deepEqual(parseTimes('3:30 PM to 4:00 PM tomorrow works'), [{ time: '15:30', day: 'tomorrow' }]);
  assert.equal(parseTimes('Open times are 10:00 AM today, 10:30 AM today or 11:00 AM today').length, 3);
});

test('names: "Myself Subham Sharma" → "Subham Sharma"', () => {
  assert.equal(extractName('Myself Subham Sharma.', { expecting: true }), 'Subham Sharma');
  assert.equal(extractDetails('Myself Subham Sharma', 'name').name, 'Subham Sharma');
});
