import hashlib
import io
import json
import logging
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from . import sarvam
from .prompts import ANSWER, EXPLAIN, EXTRACT, LANGS

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()  # iPhone photos
except ImportError:
    pass

log = logging.getLogger("parchi")
logging.basicConfig(level=logging.INFO)

STATIC = Path(__file__).parent / "static"
app = FastAPI(title="Parchi")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

_read_cache: dict[str, str] = {}


def _lang(code: str) -> str:
    if code not in LANGS:
        raise HTTPException(400, f"Unsupported language {code}")
    return code


def _prepare_image(data: bytes) -> bytes:
    """Fix phone rotation, downscale to ~1600px, re-encode as JPEG."""
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        raise HTTPException(400, "That file doesn't look like an image")
    img.thumbnail((1600, 1600))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88)
    return out.getvalue()


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.post("/api/read")
async def read(image: UploadFile = File(...)):
    raw = await image.read()
    if not raw:
        raise HTTPException(400, "Empty upload")
    if image.content_type == "application/pdf":
        data, name, mime = raw, "parchi.pdf", "application/pdf"
    else:
        data, name, mime = _prepare_image(raw), "parchi.jpg", "image/jpeg"
    key = hashlib.sha256(data).hexdigest()
    if key not in _read_cache:
        try:
            _read_cache[key] = await run_in_threadpool(sarvam.read_image, data, name, mime)
        except Exception as e:
            log.exception("read failed")
            raise HTTPException(502, f"Couldn't read the image: {e}")
    return {"raw_text": _read_cache[key]}


class ExplainIn(BaseModel):
    raw_text: str
    lang: str = "hi-IN"


def _fact_sheet(rx: dict) -> str:
    """Deterministic English facts from the structured data, so the LLM only translates and can't miscount."""
    meds = rx["medicines"]
    lines = [f"There {'is 1 medicine' if len(meds) == 1 else f'are {len(meds)} medicines'} in this prescription."]
    for i, m in enumerate(meds, 1):
        bits = [f"Medicine {i}: {m.get('name')}"]
        form = m.get("form")
        if form and form != "other":
            bits.append(f"it is a {form}")
        if m.get("purpose_simple"):
            bits.append(f"commonly used for {m['purpose_simple']}")
        if m.get("dose"):
            bits.append(f"dose {m['dose']}")
        slots = [s for s in ("morning", "afternoon", "night") if m.get(s)]
        if m.get("when_needed"):
            bits.append("take it only when needed" + (f", at {' and '.join(slots)}" if slots else ""))
        elif slots:
            bits.append(f"take it in the {' and '.join(slots)}" if len(slots) < 3 else "take it morning, afternoon and night")
        if m.get("food"):
            bits.append(f"{m['food']} food")
        if m.get("days"):
            bits.append(f"for {m['days']} days")
        if m.get("confidence") == "low":
            bits.append("this one was NOT clearly readable, please confirm it with the doctor or chemist")
        lines.append(". ".join(bits) + ".")
    if rx.get("tests"):
        lines.append("Tests advised: " + ", ".join(rx["tests"]) + ".")
    if rx.get("advice"):
        lines.append("Doctor's advice: " + "; ".join(rx["advice"]) + ".")
    if rx.get("unclear"):
        lines.append("Some parts of the prescription could not be read clearly.")
    lines.append("Please confirm everything with your doctor or chemist.")
    return "\n".join(lines)


@app.post("/api/explain")
def explain(body: ExplainIn):
    lang = _lang(body.lang)
    if len(body.raw_text.strip()) < 5:
        raise HTTPException(400, "Not enough text to understand. Try a clearer photo or type it in.")
    try:
        rx = sarvam.chat_json(
            [
                {"role": "system", "content": EXTRACT},
                {"role": "user", "content": f"OCR text:\n\n{body.raw_text[:6000]}"},
            ]
        )
    except Exception as e:
        log.exception("extract failed")
        raise HTTPException(502, f"Couldn't understand the prescription: {e}")

    rx["medicines"] = [m for m in (rx.get("medicines") or []) if isinstance(m, dict) and m.get("name")]
    for k in ("tests", "advice", "unclear"):
        rx[k] = rx.get(k) or []

    try:
        summary = sarvam.chat(
            [
                {"role": "system", "content": EXPLAIN.format(lang=LANGS[lang])},
                {"role": "user", "content": _fact_sheet(rx)},
            ],
            max_tokens=1500,
            temperature=0,
        )
    except Exception:
        log.exception("explain failed")
        summary = ""
    return {"rx": rx, "summary": summary, "lang": lang}


class SpeakIn(BaseModel):
    text: str
    lang: str = "hi-IN"


@app.post("/api/speak")
def speak(body: SpeakIn):
    lang = _lang(body.lang)
    if not body.text.strip():
        raise HTTPException(400, "Nothing to speak")
    try:
        return {"clips": sarvam.tts(body.text, lang)}
    except Exception as e:
        log.exception("tts failed")
        raise HTTPException(502, f"Couldn't generate voice: {e}")


class TranslateIn(BaseModel):
    labels: dict[str, str]
    lang: str


_label_cache: dict[str, dict] = {}


@app.post("/api/labels")
def labels(body: TranslateIn):
    """Translate the schedule card's UI labels once per language."""
    lang = _lang(body.lang)
    if lang == "en-IN":
        return body.labels
    if lang not in _label_cache:
        try:
            _label_cache[lang] = sarvam.chat_json(
                [
                    {
                        "role": "system",
                        "content": f"Translate the VALUES of this JSON object into simple, everyday {LANGS[lang]} "
                        "(native script) as used on a medicine label for an elderly person. Keep keys unchanged. "
                        "Return only the JSON object.",
                    },
                    {"role": "user", "content": json.dumps(body.labels)},
                ],
                max_tokens=800,
            )
        except Exception:
            return body.labels
    return {**body.labels, **_label_cache[lang]}


@app.post("/api/ask")
async def ask(
    audio: UploadFile = File(...),
    rx: str = Form(...),
    lang: str = Form("hi-IN"),
):
    lang = _lang(lang)
    data = await audio.read()
    if len(data) < 1000:
        raise HTTPException(400, "Recording was too short. Hold the button while speaking.")
    mime = (audio.content_type or "audio/webm").split(";")[0]
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/mpeg": "mp3"}.get(mime, "webm")
    try:
        question, detected = await run_in_threadpool(sarvam.stt, data, f"q.{ext}", mime)
    except Exception as e:
        log.exception("stt failed")
        raise HTTPException(502, f"Couldn't hear that: {e}")
    if not question:
        raise HTTPException(400, "Couldn't hear a question. Please try again a bit louder.")

    # Reply in the language they spoke, if Bulbul can speak it; otherwise the chosen language.
    reply_lang = detected if detected in LANGS else lang
    try:
        rx_obj = json.loads(rx)
        rx_obj["medicines"] = [m for m in (rx_obj.get("medicines") or []) if isinstance(m, dict) and m.get("name")]
        for k in ("tests", "advice", "unclear"):
            rx_obj[k] = rx_obj.get(k) or []
        facts = _fact_sheet(rx_obj)
    except (json.JSONDecodeError, AttributeError):
        raise HTTPException(400, "Bad prescription data")
    try:
        answer = await run_in_threadpool(
            sarvam.chat,
            [
                {"role": "system", "content": ANSWER.format(facts=facts, lang=LANGS[reply_lang])},
                {"role": "user", "content": question},
            ],
            max_tokens=500,
            temperature=0,
        )
        clips = await run_in_threadpool(sarvam.tts, answer, reply_lang) if answer else []
    except Exception as e:
        log.exception("answer failed")
        raise HTTPException(502, f"Couldn't answer: {e}")
    return {"question": question, "answer": answer, "lang": reply_lang, "clips": clips}
