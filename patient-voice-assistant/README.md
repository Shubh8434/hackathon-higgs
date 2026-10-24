# Patient Voice Assistant

> "A voice assistant that books care, and when it's an emergency, it puts the patient first, automatically."

A live voice booking assistant for a mock clinic, built on Boson AI's Higgs APIs:

- **Higgs Realtime** runs the conversation: full-duplex voice, server VAD, barge-in, and live captions.
- **Higgs STT 3.1** transcribes the patient inside the Realtime session. The keyword safety net reads that transcript.
- **Higgs Avatar** renders 3 short clips once (welcome, emergency reassurance, booking confirmed) and replays them at key moments.
- **Higgs TTS 3** voices the demo phrases into the live session and is the assistant's voice in offline mode.

The differentiator is **emergency pre-emption**. When the patient describes red-flag symptoms, the screen turns red and an EMERGENCY booking takes the doctor's next same-day slot. The normal booking already in that slot visibly slides down to the next free slot on the clinic dashboard.

This project is self-contained. It has its own server, `.env`, port (3100) and UI, and zero npm dependencies, so it doesn't depend on the playground in the parent folder and doesn't affect it.

## Run

Requires Node 18 or later. There is nothing to `npm install`.

```bash
cd patient-voice-assistant
cp .env.example .env        # add BOSON_API_KEY=bai-…
npm start                   # → http://localhost:3100
```

Open the page in Chrome. Click **Start voice session** and allow the microphone.

**Demo mode** works with or without a live session:

| | What happens when you tap a demo phrase or type a line |
| --- | --- |
| **Live** | The phrase is synthesized with TTS 3 and streamed into the Realtime session as patient audio. It goes through the same STT → model → voice path as the mic. |
| **Offline** | A scripted assistant answers with the TTS 3 voice. If TTS fails, it falls back to the browser's speech synthesis. |

### Avatar clips (one-time)

Open **Avatar clips** in the left column, choose a face image, and click **Render missing clips**. The renders take a minute or two. You can also render from the command line:

```bash
npm run render-clips -- path/to/face.png     # or an https URL; --force to redo
```

The clips are cached in `clips/`. Until they exist, each clip's line is shown as a caption instead. During a live session, clips play muted so they never talk over the model.

### Backup video

Record a roughly 30-second screen capture of the whole flow and save it as `public/backup/backup-demo.mp4`. The **🎞 Backup video** button plays it.

## Demo sequence (rehearse this twice)

1. **Emergency first (1–2 min).** Say or tap: *"I have severe chest pain and shortness of breath."*
   - The character turns into a red alert, and the banner shows *Detected by: STT safety net*.
   - The EMERGENCY booking appears for Dr. Chen at 9:00 today. Robert Hall's normal booking slides down to 10:00.
   - An SMS arrives on the phone.
   - Ava asks for name, address and phone, one at a time. The form fills in as you answer. You can also tap *"Name, address, phone"*.
2. **Normal booking (1–2 min).** Click **↺ Reset demo**, then say *"I'd like to book a routine checkup."*
   - Dr. Patel is recommended, with three open times.
   - Say *"10:30 tomorrow works"* or *"the first one."* Ava holds the slot (shown as a 30-minute range, e.g. 10:30 AM to 11:00 AM) and asks for name, address and phone, one at a time. The **Patient details** box highlights the field she's waiting for. The address is taken as said; she never asks for city or postal code.
   - Ava reads all three back and asks *"Is that all correct?"* Say *yes*, or name what to fix.
   - On *yes*, the payment screen opens and the conversation pauses (mic, demo phrases and typing are off). Tap **Done** to book or **Release hold** to pick another time; Ava then acknowledges.
   - The cards fill in, the confirmed clip plays, and the receipt SMS arrives. The slot is held for 5 minutes in the background; the payment screen shows the countdown.
3. **Barge-in (30 s).** While Ava is talking, start speaking. Her audio stops at once and the character switches to listening.

Cost to quote: about $0.05–$0.10 per 5-minute call (Boson docs). The header shows a live session timer and cost estimate.

## How it works

```
Browser                                           server.js (Node stdlib)
───────                                           ───────────────────────
mic ─PCM16 24k─▶ wss://api.boson.ai/v1/realtime   POST /api/realtime/client-secret ─▶ Boson
   ◀─audio + transcripts──┘   (ephemeral key)     POST /api/tts                    ─▶ Boson TTS 3
        │                                         GET/POST /api/clips[/render]     ─▶ Boson Avatar
        ▼                                         GET  /api/state      ┐
  orchestrator.js ──hold/pay/emergency──────────▶ POST /api/holds      │ lib/db.js
   │  ▲  (keyword safety net, symptom map,        DELETE /api/holds/:id│ in-memory clinic:
   │  │   doctor/time parsing, detail capture)    POST /api/bookings/:id/pay   5 doctors,
   │  └── UI clicks (doctor, slot, Done)          PATCH /api/bookings/:id      holds, SMS,
   └──▶ session.update(instructions + state)      POST /api/emergency  │ pre-emption
        conversation.item.create + response.create POST /api/reset     ┘
```

- **The screen is the source of truth.** Every state change re-sends the model's instructions with the current doctor directory, open slots, hold, booking ID and missing emergency details, plus a suggested next line.
- **Screen events reach the model as text.** When something happens on screen (Done tapped, slot clicked, safety-net alert), a short `[Clinic screen]` note goes in as a text user item, followed by `response.create`. Higgs rejects a bare `response.create` with "No user input" when the assistant spoke last.
- **Safety net.** Red-flag keywords are checked on the live patient transcript, including partial transcripts. A hit forces the emergency flow even if the model missed it. The banner shows whether the safety net, the model, or a manual trigger raised the alert.
- **Keyword highlighting in captions:**
  - doctors and times → blue
  - payment words → amber
  - emergency words → red
- **The character has four states:** idle, listening, speaking and alert. They're driven by the session, the playback state and emergency mode.

## Layout

```
server.js            HTTP server: static files, Boson proxy, clinic API
lib/env.js           .env loader
lib/boson.js         Boson REST client (key stays server-side)
lib/db.js            Mock clinic: doctors, 30-min slots, 5-min holds, pay, emergency pre-emption, SMS
lib/clips.js         Avatar clip definitions + render/cache
scripts/render-clips.js
public/index.html    Single-page UI
public/styles.css
public/js/main.js          Wiring: session ⇄ orchestrator ⇄ UI, demo mode, timers
public/js/orchestrator.js  Conversation brain + model instructions
public/js/keywords.js      Red flags, symptom map, doctor/time parsing, highlighting (pure)
public/js/realtime.js      Higgs Realtime WebSocket, mic capture, PCM playback, barge-in
public/js/audio.js         PCM16/base64 helpers, decode → 24 kHz PCM16
public/js/speech.js        Offline assistant voice (TTS 3, browser fallback)
public/js/avatar.js        Clip playback + render panel
public/js/ui.js            Render functions (cards, doctors, dashboard, phone, banner)
public/js/api.js           Client for this server
test/                      node --test unit tests (keywords, clinic DB)
```

```bash
npm test
```

## Scope (per the build plan)

**In scope:** everything in the plan's "Build exactly this" list.

**Out of scope, on purpose:**
- OTP or PIN verification
- cancellation flow
- human hand-off
- reconnect logic
- real Stripe or Twilio
- call history

The schedule is a fixed, deterministic two-day demo calendar, so the demo plays out the same way every time. **↺ Reset demo** reseeds it.
