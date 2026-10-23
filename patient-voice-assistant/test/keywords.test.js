import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRedFlag, detectModelEmergency, detectSpecialty, detectDoctor, emergencyDoctorFor,
  parseTimes, matchSlot, isConfirmation, isBookingIntent, extractPhone, extractAddress,
  extractName, extractDetails, highlightSegments,
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
