"""Thin wrappers around the Sarvam SDK. The API key is read from .env and never leaves the server."""
import io
import json
import os
import re
import time
import urllib.request
import zipfile
from pathlib import Path

from dotenv import load_dotenv
from sarvamai import SarvamAI

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
_key = os.environ.get("SARVAM_API_KEY", "").strip()
if not _key or "paste_your" in _key:
    raise RuntimeError("SARVAM_API_KEY missing — put it in Buildathon/.env")

client = SarvamAI(api_subscription_key=_key)

CHAT_MODEL = "sarvam-105b"
TTS_MODEL = "bulbul:v3"
STT_MODEL = "saaras:v4"
TTS_LIMIT = 2500

_PENDING = {"pending", "processing", "running", "queued", "accepted", "in_progress"}


def read_image(data: bytes, filename: str, mime: str, timeout: float = 90) -> str:
    """Sarvam Vision (Document AI digitise): async job -> poll -> zip -> text in reading order."""
    job = client.doc_ai.digitise(
        file=[(filename, data, mime)], language="en-IN", content_type="mixed"
    )
    start = time.time()
    while True:
        st = client.doc_ai.get_status(job_id=job.job_id)
        if st.status not in _PENDING:
            break
        if time.time() - start > timeout:
            raise TimeoutError("Reading the image took too long")
        time.sleep(1.5)
    if st.status not in ("completed", "partially_completed"):
        raise RuntimeError(f"Could not read the image (status: {st.status})")

    url = client.doc_ai.get_download_url(job_id=job.job_id).url
    with urllib.request.urlopen(url, timeout=60) as r:
        z = zipfile.ZipFile(io.BytesIO(r.read()))

    pages = sorted(n for n in z.namelist() if "/metadata/page_" in n and n.endswith(".json"))
    out = []
    for name in pages:
        page = json.loads(z.read(name))
        blocks = sorted(page.get("blocks", []), key=lambda b: b.get("reading_order", 0))
        out.extend(b.get("text", "").strip() for b in blocks if b.get("text", "").strip())
    return "\n\n".join(out).strip()


def chat(messages: list, max_tokens: int = 2000, temperature: float = 0.2) -> str:
    # reasoning_effort=None disables thinking: ~0.5s instead of ~20s, and no empty replies.
    r = client.chat.completions(
        model=CHAT_MODEL,
        messages=messages,
        reasoning_effort=None,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return (r.choices[0].message.content or "").strip()


def _parse_json(text: str):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def chat_json(messages: list, max_tokens: int = 3000) -> dict:
    """Chat that must return a JSON object; one retry with a stricter nudge."""
    text = chat(messages, max_tokens=max_tokens, temperature=0.1)
    try:
        return _parse_json(text)
    except (json.JSONDecodeError, ValueError):
        retry = messages + [
            {"role": "assistant", "content": text},
            {"role": "user", "content": "That was not valid JSON. Return ONLY the JSON object, nothing else."},
        ]
        return _parse_json(chat(retry, max_tokens=max_tokens, temperature=0))


def _chunks(text: str, limit: int = 450):
    """Split on sentence ends so each TTS call stays short and natural."""
    parts = re.split(r"(?<=[.!?।])\s+", text.strip())
    buf = ""
    for p in parts:
        while len(p) > limit:  # pathological long sentence
            yield p[:limit]
            p = p[limit:]
        if len(buf) + len(p) + 1 > limit and buf:
            yield buf
            buf = p
        else:
            buf = f"{buf} {p}".strip()
    if buf:
        yield buf


_tts_cache: dict = {}


def tts(text: str, lang: str, speaker: str = "priya", pace: float = 0.9) -> list[str]:
    """Bulbul TTS -> list of base64 WAV clips (played back to back in the browser)."""
    key = (text, lang, speaker, pace)
    if key in _tts_cache:
        return _tts_cache[key]
    clips = []
    for chunk in _chunks(text):
        r = client.text_to_speech.convert(
            text=chunk, model=TTS_MODEL, language_code=lang, speaker=speaker, pace=pace
        )
        clips.append("".join(r.audios))
    _tts_cache[key] = clips
    return clips


def stt(data: bytes, filename: str, mime: str) -> tuple[str, str | None]:
    """Saaras STT for a short (<30s) clip. Returns (transcript, detected_language_code)."""
    r = client.speech_to_text.transcribe(
        file=(filename, data, mime), model=STT_MODEL, mode="transcribe"
    )
    return (r.transcript or "").strip(), r.language_code

