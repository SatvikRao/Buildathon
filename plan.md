# Parchi — plan

> Photo of a prescription → the app explains it aloud in your language → a shareable medicine schedule → follow-up questions by voice.

**User:** an elderly or low-literacy patient, or a family member helping them.
**One flow:** 📷 photo → 📝 read → 💊 structure → 🔊 speak → 📅 schedule card → 🎙️ ask.
**Goal:** a working flow by :10. Only build extras after the core flow works end to end.

---

## 1. Architecture

```
Browser (single HTML page, mobile-first)
  │  photo / mic recording / language choice
  ▼
FastAPI backend (Python)  ── reads SARVAM_API_KEY from .env
  ├─ POST /api/read      image → Sarvam Vision (Doc AI digitise, md) → raw text
  ├─ POST /api/explain   raw text + lang → sarvam-105b (JSON) → medicines[] + spoken summary
  ├─ POST /api/speak     text + lang → Bulbul TTS → base64 WAV
  └─ POST /api/ask       audio + context → Saaras STT → sarvam-105b → answer text (+ audio)
```

**Why a backend:** the API key never reaches the browser (tip 05). **Why no database:** the app holds state for one session only, in memory or on the client.

## 2. Sarvam APIs used (checked against docs.sarvam.ai)

| Step | API | Key details |
|---|---|---|
| Read | **Document AI (Sarvam Vision)**: `client.doc_ai.digitise(file=[(name, f, "image/jpeg")], language="en-IN", output_format="md")` | **Async:** poll `get_status(job_id)` until `completed`, then `get_download_url` → ZIP containing a `.md` file. Accepts PNG, JPG, PDF. Pass `en-IN` for English or mixed prescriptions (most are). Calling results early returns 409. |
| Structure + explain + Q&A | **Chat**: `client.chat.completions(model="sarvam-105b", messages=..., response_format=...)` | `POST /v1/chat/completions`. Text only, not images. Use `temperature` 0.2. |
| Speak | **TTS**: `client.text_to_speech.convert(text, model="bulbul:v3", language_code, speaker, pace)` | Max 2500 characters per call. Response `audios[]` holds base64 WAV, which you join and decode. Speakers include `priya`, `kavya`, `shubh`. Use `pace` 0.85 for elderly listeners. |
| Listen | **STT**: `client.speech_to_text.transcribe(file, model="saaras:v4", mode="transcribe")` | Clips of 30 s or less. Browser `webm` works. The response's `language_code` tells you what language to answer in. |

Auth for everything: `SarvamAI(api_subscription_key=os.environ["SARVAM_API_KEY"])`.
Install: `pip install sarvamai fastapi uvicorn python-multipart python-dotenv`.

**Check on day 1:** whether the Bulbul model ID is `bulbul:v3`. The docs examples use `bulbul:v4-flash`, so use whichever your key accepts.

## 3. File layout

```
Buildathon/
├── .env                  SARVAM_API_KEY=...   (gitignored)
├── plan.md
├── requirements.txt
├── app/
│   ├── main.py           FastAPI routes + serves static/
│   ├── sarvam.py         thin wrappers: read_image, chat_json, tts, stt
│   ├── prompts.py        system prompts (extract, explain, answer)
│   └── static/
│       ├── index.html    the single page
│       ├── app.js        camera/upload, MediaRecorder, audio playback
│       └── style.css     big text, high contrast, large buttons
└── samples/              5–10 real prescription photos + expected output
```

## 4. Implementation phases

### Phase 0: Setup (15 min)
- [ ] Create a venv, write `requirements.txt` and install it.
- [ ] Load `.env` with `python-dotenv` and fail loudly if the key is missing.
- [ ] Smoke test each API with a ~10-line script: TTS "namaste", STT on a recorded clip, a chat ping, digitise on one image.
- [ ] Collect sample images: your own or family prescriptions, plus images found online. Include at least one messy handwritten one and one printed lab report.

### Phase 1: Read the prescription (45 min)
- [ ] `sarvam.read_image(bytes, mime) -> str`: call digitise, poll every 1.5 s (60 s timeout), download the ZIP, return the `.md` text.
- [ ] Before uploading, downscale the image to ~1600 px on its longer side and convert HEIC to JPEG with Pillow.
- [ ] `/api/read` returns `{raw_text}`.
- [ ] **Fallback if OCR comes back near-empty:** a textarea where the user types or corrects the text. The flow must never dead-end.

### Phase 2: Structure + explain (60 min) ← the heart of the product
- [ ] Prompt `sarvam-105b` with the raw OCR text and ask for **strict JSON**:
  ```json
  {
    "doctor": "...", "patient": "...", "date": "...",
    "medicines": [
      {"name": "Paracetamol 650", "purpose_simple": "fever/pain",
       "dose": "1 tablet", "morning": true, "afternoon": false, "night": true,
       "food": "after", "days": 5, "confidence": "high|low", "raw": "Tab PCM 650 1-0-1 x5d AF"}
    ],
    "tests": ["CBC"], "warnings": ["..."], "unclear": ["line the model couldn't read"]
  }
  ```
- [ ] The prompt must decode Indian prescription shorthand: `1-0-1`, `OD/BD/TDS/QID/HS/SOS`, `AC/PC`, `x5d`, and `Tab/Cap/Syp/Inj`.
- [ ] **Safety rules in the prompt:** never invent a medicine or dose. Mark anything uncertain as `confidence: low` and add it to `unclear`. Never give advice beyond what is written. Always end with "confirm with your doctor or pharmacist".
- [ ] Parse the JSON defensively: strip ``` fences and retry once with "return valid JSON only".
- [ ] Make a second call that writes a **spoken summary in the target language**: short sentences, plain words, simple numbers ("subah ek goli, raat ko ek goli, khaane ke baad, paanch din"). Keep it under 2500 characters. Alternatively, have the first call return `summary_<lang>` as well, to save a round trip.

### Phase 3: Speak (30 min)
- [ ] `/api/speak` → Bulbul, return base64 WAV → play it in an `<audio>` element.
- [ ] Add a language picker: Hindi, Tamil, Telugu, Kannada, Bengali, Marathi and English (`hi-IN`, `ta-IN`, ...).
- [ ] Add a 🔊 button on **each medicine row** to read just that medicine. Elderly users replay these a lot.
- [ ] Cache audio by `(text, lang)` in a dict.

### Phase 4: Schedule card + share (45 min)
- [ ] Render a big-font card with a 🌅 morning / ☀️ afternoon / 🌙 night grid, a ✓ for each medicine, a food icon (🍽️ before or after), and the number of days.
- [ ] Translate the column labels into the chosen language. Medicine names stay in English, since that's what the pharmacy strip says.
- [ ] Show `confidence: low` items with an orange "⚠️ check with pharmacist" badge.
- [ ] **Share:** use `navigator.share()` with the card text on mobile. The fallback is a `https://wa.me/?text=<encoded>` link. Optionally render the card to PNG with `html2canvas` so it can be shared as an image.

### Phase 5: Ask by voice (45 min)
- [ ] A big 🎙️ hold-to-talk button that records with `MediaRecorder` (webm) and stops automatically at 25 s.
- [ ] `/api/ask` → Saaras transcript → `sarvam-105b`, with the structured JSON as context. Answer **in the detected language**, in 2–3 short sentences, using only the prescription. If something isn't on it, say "doctor se poochiye" ("ask the doctor").
- [ ] Return the transcript, the answer text and the answer audio, and display them as a chat bubble.
- [ ] Test questions to try: "khaana khaane ke pehle ya baad?" ("before or after eating?"), "ye goli kis liye hai?" ("what is this tablet for?"), "kitne din leni hai?" ("how many days do I take it?"), and a Tamil code-mixed question.

### Phase 6: Polish + demo prep (remaining time)
- [ ] Show a loading state for each step with friendly text: "Reading your parchi…", "Understanding the medicines…".
- [ ] Add a small permanent disclaimer footer: "Parchi explains, it doesn't prescribe."
- [ ] Pre-load one sample prescription behind a "Try a sample" button, in case the camera or wifi fails on stage.
- [ ] Run every image in `samples/` and fix the prompt for whatever breaks (tip 04).

## 5. UI (one screen, a vertical flow)

```
┌──────────────────────────────┐
│  Parchi        [हिंदी ▾]      │
│  ┌────────────────────────┐  │
│  │   📷 Take photo /      │  │
│  │      Upload            │  │
│  └────────────────────────┘  │
│  ▶ 🔊 Listen to explanation   │
│  ┌ Medicine schedule ──────┐ │
│  │        🌅  ☀️  🌙  🍽️  days│ │
│  │ PCM650 ✓   ·   ✓  after 5 │🔊
│  │ Pan40  ✓   ·   ·  before 7│🔊
│  │ ⚠️ 1 line unclear — ask   │ │
│  └─────────────────────────┘ │
│  [ Share on WhatsApp ]        │
│        ( 🎙️ hold to ask )     │
└──────────────────────────────┘
```
Use a base font of 18 px or more, tap targets of 48 px or more, and high contrast. Design it for someone's grandmother.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Doc AI is async and slow (10–30 s) | Show a progress message. Pre-warm with a sample before the demo. Cache results by image hash. |
| OCR misreads doctor handwriting | Mark low-confidence items, keep the raw line visible, offer the editable text fallback, and never hide uncertainty. |
| LLM hallucinates a medicine or dose | Ground the prompt only in the OCR text. Show the `raw` text next to each item. Add the disclaimer. |
| LLM returns broken JSON | Strip fences, retry once, then fall back to showing the plain-text summary. |
| Clip longer than 30 s fails STT | Stop recording automatically at 25 s. |
| Explanation over 2500 characters fails TTS | Split it into sentences and run TTS on each chunk. |
| Key leaks | Keep it in `.env` only (already gitignored), use it only on the backend, never log it. |

## 7. Demo script (90 seconds)
1. **The problem (15 s):** "My nani gets a parchi she can't read. Is it 1-0-1 or 1-1-1? Before or after food?"
2. **Live (45 s):** photograph a real, messy prescription → pick Tamil or Hindi → the app speaks → show the schedule card.
3. **Voice (20 s):** ask "khaana khaane ke baad lena hai na?" ("I take it after eating, right?") → the app answers aloud.
4. **Close (10 s):** share to WhatsApp. "One photo, any Indian language, no reading required."

## 8. Stretch goals (only if the core flow works)
- Bill mode: explain a hospital or pharmacy bill and flag items that are charged twice.
- Reminder export: generate an `.ics` file of medicine reminders.
- Lab report mode: mark values as "normal / high / low" in plain words.
- Ask the pharmacist: TTS a question in English for the user to show at the counter.

## 9. Definition of done
- [ ] A real handwritten prescription goes photo → spoken Hindi or Tamil explanation in under 40 s.
- [ ] The schedule card is correct for at least 4 of 5 sample prescriptions, and the wrong one is flagged ⚠️.
- [ ] A voice question in code-mixed Hindi gets a correct spoken answer.
- [ ] Sharing works from a phone.
- [ ] The key is only in `.env`, and `git status` shows `.env` untracked or ignored.
