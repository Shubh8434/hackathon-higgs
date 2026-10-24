# Patient Voice Assistant

> "A voice assistant that books care, and when it's an emergency, it puts the patient first, automatically."

A live voice agent for a mock clinic, built on Boson AI's Higgs Audio APIs. Ava books, reschedules and triages appointments in a natural conversation, and acts on a real clinic calendar.

- **Higgs Realtime** runs the conversation: full-duplex voice, server VAD, barge-in and live captions.
- **Higgs STT 3.1** transcribes the patient inside the Realtime session. Every decision, including the emergency safety net, reads that transcript.
- **Higgs TTS 3** voices demo phrases into the live session as patient audio, and is Ava's voice in offline mode.

## Hackathon submission

| | |
| --- | --- |
| **Event** | Higgs Audio Hackathon 2026 (Boson AI) |
| **Track** | Agents That Act |
| **One-liner** | A voice agent that books, reschedules and triages clinic appointments, and when it hears an emergency, gives the patient the nearest slot automatically. |
| **Team** | Shubham Sharma ([@Shubh8434](https://github.com/Shubh8434)) |
| **Code** | This folder of [Shubh8434/hackathon-higgs](https://github.com/Shubh8434/hackathon-higgs), tag `submission` |
| **Docs** | [Project summary (PDF)](Patient_Voice_Assistant_Project_Summary.pdf) · [Higgs API feedback report (PDF)](Higgs_API_Feedback_Report.pdf) |

### Write-up

Maple Clinic's assistant, Ava, books, reschedules and triages medical appointments in a natural, phone-style voice conversation. Patients describe their problem, and Ava picks the right specialist, checks a live 90-day calendar and offers the nearest open times. She understands requests like "anything Wednesday afternoon after 3?", collects name, address and phone one at a time, reads them back for a final check, and opens a payment screen. Receipts arrive as SMS on a virtual phone, and the clinic dashboard updates live.

The differentiator is emergency pre-emption. A safety net scans the live, partial transcript for red flags such as chest pain, stroke signs or choking. The moment one appears, the screen turns red and Ava gives the patient the nearest same-day slot with the right doctor, moving whoever was booked there and texting them. On Sundays or after hours she tells the patient to call 911 and books a priority follow-up instead.

Existing bookings can be rescheduled by voice with the booking ID or phone number. Every conversation and booking is saved, so a refreshed page resumes where it left off. The screen is always the source of truth: Ava never promises a time the calendar doesn't have.

### Technical description

Higgs Realtime runs the whole conversation over a WebSocket with ephemeral client secrets: full-duplex PCM16 24 kHz audio, server VAD, barge-in and live captions. Higgs STT 3.1 transcribes the patient inside the session, and those transcripts drive everything, including a red-flag safety net that runs on partial transcripts. Higgs TTS 3 synthesizes demo phrases that are streamed into the live session as patient audio, so demos exercise the same STT → agent → voice path as the microphone. It also voices Ava offline.

The novel part is that the app, not the model, decides when Ava speaks (`create_response: false`). Each finished sentence is parsed (symptoms, doctors, dates, times, ordinals, phone digits) and applied to the clinic calendar. Only then does Ava receive an authoritative next line and a `response.create`. We measured that the default mode starts replying before the transcript arrives, which made the model invent availability. Guards check every assistant turn and correct off-script claims such as wrong times, address follow-ups or a premature payment step. An on-screen pipeline strip shows per-turn latency, about 0.9 s from end of speech to first audio. Zero npm dependencies, 50 automated tests.

### Known limitations

- **Mock clinic:** the calendar, payment (a **Done** button) and SMS are simulated. There's no real Stripe or Twilio.
- **English only**, and emergency triage is keyword-based. It is a demo, not medical advice.
- **No cancellation flow or identity verification:** a booking ID or phone number is enough to reschedule.
- **The model can still go off script occasionally.** App-side guards correct it live, but you may hear the wrong sentence before the correction.
- **STT can mishear names and streets.** Ava reads details back for confirmation, and any field can be corrected on screen.
- **Speaker echo can interrupt Ava.** Use headphones. The app recovers by re-answering, but there's a short pause.
- **Higgs Avatar isn't used in the UI.** The server-side clip renderer (`lib/clips.js`) is still in the repo but unused.
- **Single-user demo:** one in-memory clinic per server, with bookings and conversations stored as JSON files in `data/`.

## Run

Requires Node 18 or later. There is nothing to `npm install`.

```bash
git clone https://github.com/Shubh8434/hackathon-higgs.git
cd hackathon-higgs/patient-voice-assistant
cp .env.example .env        # add BOSON_API_KEY=bai-…
npm start                   # → http://localhost:3100
```

Open the page in Chrome, click **Start voice session** and allow the microphone. Headphones are recommended. For a clean demo, delete the `data/` folder before starting; it holds saved conversations and bookings.

**Demo mode** works with or without a live session:

| | What happens when you tap a demo phrase or type a line |
| --- | --- |
| **Live** | The phrase is synthesized with TTS 3 and streamed into the Realtime session as patient audio. It goes through the same STT → agent → voice path as the mic. |
| **Offline** | A scripted assistant answers with the TTS 3 voice. If TTS fails, it falls back to the browser's speech synthesis. |

### Backup video

Record a roughly 30-second screen capture of the whole flow and save it as `public/backup/backup-demo.mp4`. The **🎞 Backup video** button plays it.

## Demo sequence

1. **Emergency (40 s).** Say or tap: *"I have severe chest pain and shortness of breath."*
   - The character turns into a red alert. The banner shows *Detected by: STT safety net*, and the pipeline strip shows the red flag was caught on the partial transcript.
   - The EMERGENCY booking takes Dr. Chen's nearest slot today. Robert Hall's normal booking moves to Dr. Chen's next open slot and he is texted. If the specialist is off today, a working doctor covers.
   - On Sundays or after clinic hours, Ava says to call 911 or go to the ER, and books a priority follow-up instead.
   - Ava asks for name, address and phone, one at a time.
2. **Normal booking (60 s).** Click **↺ Reset demo**, then say *"I'd like to book a routine checkup."*
   - Dr. Patel is recommended with the three nearest open times. Ask for a day (*"anything Wednesday afternoon?"*, *"November 5th?"*) or browse the **📅 Availability calendar** under Doctors.
   - Say *"the first one."* Ava holds the slot (a 30-minute range) and asks for name, address and phone. The **Patient details** box highlights the field she's waiting for. The address is taken as said.
   - Ava reads all three back and asks *"Is that all correct?"* On *yes*, the payment screen opens and the conversation pauses. Tap **Done**. The receipt SMS arrives.
3. **Reschedule (30 s).** Say *"Can I reschedule my appointment?"*. In a new chat, Ava asks for the booking ID (shown on the dashboard) or phone number. Ask for a day, pick a time, and confirm with *yes*. The booking keeps its ID and payment, and an SMS with the new time arrives.
4. **Barge-in (10 s).** While Ava is talking, start speaking. Her audio stops at once.

The header shows a live clock, session timer and cost estimate (about $0.05–$0.10 per 5-minute call, per Boson's docs).

## How it works

```
Browser                                           server.js (Node stdlib)
───────                                           ───────────────────────
mic ─PCM16 24k─▶ wss://api.boson.ai/v1/realtime   POST /api/realtime/client-secret ─▶ Boson
   ◀─audio + transcripts──┘   (ephemeral key)     POST /api/tts                    ─▶ Boson TTS 3
        │                                         GET  /api/state, /api/availability/:doctor
        ▼                                         POST /api/holds, DELETE /api/holds/:id
  orchestrator.js ──hold/pay/move/emergency─────▶ POST /api/bookings/:id/pay | /reschedule
   │  ▲  (safety net, symptom map, dates,         PATCH /api/bookings/:id
   │  │   times, details, guards)                 POST /api/emergency, POST /api/reset
   │  └── UI clicks (doctor, slot, Done)          GET/POST/PUT /api/conversations[/:id]
   └──▶ session.update(instructions + state)      GET /api/booking-records[/:id]
        then response.create                       lib/db.js (calendar) · lib/records.js · lib/conversations.js
```

- **The app decides when Ava speaks.** Turn detection uses `create_response: false`. For each finished patient sentence, the orchestrator updates the clinic, rebuilds Ava's instructions (current date and time, open times, booking state, an authoritative *NEXT LINE*), then sends `response.create`. Replies are retried if Higgs is busy or a reply is cut off.
- **Guards on what Ava says.** Every assistant turn is checked. If she names a time that isn't on screen, asks about city or street after an address, or jumps to the final check or payment too early, she is corrected immediately.
- **Screen events reach the model as text.** When something happens on screen (Done tapped, safety-net alert), a short `[Clinic screen]` note goes in as a text user item, followed by `response.create`. Higgs rejects a bare `response.create` with "No user input" when the assistant spoke last.
- **Safety net.** Red-flag keywords are checked on the live patient transcript, including partial transcripts, and negations ("not urgent") are ignored. A hit forces the emergency flow even if the model missed it.
- **Real calendar.** 90 days ahead from now: Monday to Saturday, 9–12 and 2–4, 30-minute slots, closed Sundays. Each doctor's days off and blocked times are pseudo-random but fixed (hashed from doctor, date and time).
- **Persistence.** Every conversation is saved to `data/conversations/` (a refresh restores it, and **History…** reopens past chats). Every booking is saved to `data/bookings.json` with its full history. Upcoming confirmed bookings are restored on start and on **↺ Reset demo**.
- **Higgs pipeline strip.** Under the captions, each turn shows STT transcript time → clinic-agent decision → Realtime first-audio time.
- **Keyword highlighting in captions:** doctors and times blue, payment amber, emergency red.

## Layout

```
server.js            HTTP server: static files, Boson proxy, clinic + history API
lib/env.js           .env loader
lib/boson.js         Boson REST client (key stays server-side)
lib/db.js            Clinic calendar: doctors, availability, holds, pay, reschedule, emergency triage, SMS
lib/records.js       Bookings database (data/bookings.json)
lib/conversations.js Conversation history (data/conversations/)
lib/clips.js         Avatar clip render/cache (server API only; not used by the UI)
scripts/render-clips.js
public/index.html    Single-page UI
public/styles.css
public/js/main.js          Wiring: session ⇄ orchestrator ⇄ UI, reply control, pipeline strip, history, calendar
public/js/orchestrator.js  Conversation brain, guards and model instructions
public/js/keywords.js      Red flags, symptom map, date/time/phone/ID parsing, highlighting (pure)
public/js/realtime.js      Higgs Realtime WebSocket, mic capture, PCM playback, barge-in
public/js/audio.js         PCM16/base64 helpers, decode → 24 kHz PCM16
public/js/speech.js        Offline assistant voice (TTS 3, browser fallback)
public/js/ui.js            Render functions (cards, doctors, calendar, dashboard, phone, banner)
public/js/api.js           Client for this server
test/                      node --test: keywords, clinic calendar, bookings DB, conversations
```

```bash
npm test     # 50 tests
```

## Scope

**Out of scope, on purpose:** OTP or PIN verification, a cancellation flow, human hand-off, reconnect logic, and real Stripe or Twilio.
