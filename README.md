# Parchi ℞

Photo of a prescription → explained aloud in your language → medicine schedule card → ask questions by voice.

Built on Sarvam AI: **Sarvam Vision** (reads the handwriting) · **Sarvam-105B** (understands it) · **Bulbul v3** (speaks) · **Saaras v4** (listens).

## Run

```bash
# one-time
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
# key goes in .env:  SARVAM_API_KEY=...

.venv/bin/uvicorn app.main:app --port 8000
```

Open http://localhost:8000 and tap **Try a sample**, or upload a photo.

**On a phone:** the microphone only works over HTTPS. Expose the laptop with a tunnel, for example `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`, and open that https URL.

## Deploy (Vercel)
Import this repo in Vercel. `app/main.py` is auto-detected as a FastAPI app. Add the environment variable `SARVAM_API_KEY` in Project Settings, then deploy. `vercel.json` raises the function time limit to 120 s, since reading a photo can take up to ~90 s.

## How it stays accurate
1. Vision OCR → raw text (editable if the photo was bad).
2. Sarvam-105B turns it into strict JSON, decoding shorthand like `1-0-1`, `BD`, `HS`, `SOS`, `AC/PC` and `x5d`. Unsure items are flagged ⚠️ and never guessed.
3. The spoken summary is built **in code** from that JSON as a fact sheet. The LLM only translates it, so counts, doses and days can't drift.
4. Voice answers are grounded only in that fact sheet. Anything else gets "ask your doctor or chemist".

## Layout
- `app/sarvam.py`: Sarvam API wrappers (Doc AI job polling, chat, TTS chunking, STT)
- `app/prompts.py`: extraction / explanation / answer prompts
- `app/main.py`: FastAPI routes `/api/read`, `/api/explain`, `/api/speak`, `/api/labels`, `/api/ask`
- `app/static/`: single-page mobile UI
