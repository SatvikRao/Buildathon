"use strict";

const $ = (id) => document.getElementById(id);
const state = { rx: null, summary: "", lang: "hi-IN", rawText: "", labels: null };

const EN_LABELS = {
  title: "Medicine schedule",
  medicine: "Medicine",
  morning: "Morning",
  afternoon: "Afternoon",
  night: "Night",
  food: "Food",
  days: "Days",
  before: "Before food",
  after: "After food",
  with: "With food",
  whenNeeded: "Only when needed",
  check: "Not clear, check with chemist",
  listen: "Listen",
  tests: "Tests",
  advice: "Advice",
  unclear: "Could not read",
  share: "Share on WhatsApp",
  hold: "Hold to ask",
  release: "Release to send",
  disclaimer: "Parchi explains, it doesn't prescribe. Always confirm with your doctor or chemist.",
};

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((body && body.detail) || `Something went wrong (${res.status})`);
  return body;
}
const postJSON = (path, data) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

function show(id, on = true) { $(id).hidden = !on; }
function busy(text) {
  if (text) { $("status-text").textContent = text; show("status"); show("error", false); }
  else show("status", false);
}
function fail(err) {
  busy(null);
  $("error-text").textContent = err.message || String(err);
  show("error");
}
const L = (k) => (state.labels && state.labels[k]) || EN_LABELS[k];

// ---------- audio: play base64 WAV clips back to back ----------
const player = $("player");
let queue = [];
let onDone = null;
function playClips(clips, done) {
  stopAudio();
  queue = clips.slice();
  onDone = done || null;
  next();
}
function next() {
  if (!queue.length) { const d = onDone; onDone = null; d && d(); return; }
  player.src = "data:audio/wav;base64," + queue.shift();
  player.play().catch(() => { queue = []; next(); });
}
player.addEventListener("ended", next);
function stopAudio() {
  queue = [];
  player.pause();
  const d = onDone; onDone = null; d && d();
}

async function speak(text, btn) {
  if (!text) return;
  const ico = btn && (btn.querySelector(".ico") || btn);
  const prev = ico && ico.textContent;
  try {
    if (btn) { btn.disabled = true; ico.textContent = "⏳"; }
    const { clips } = await postJSON("/api/speak", { text, lang: state.lang });
    if (btn) { btn.disabled = false; ico.textContent = "⏹"; }
    playClips(clips, () => { if (btn) ico.textContent = prev; });
  } catch (e) {
    if (btn) { btn.disabled = false; ico.textContent = prev; }
    fail(e);
  }
}

// ---------- step 1: photo -> text ----------
async function handleFile(file) {
  if (!file) return;
  resetResults();
  if (file.type.startsWith("image/")) {
    $("preview").src = URL.createObjectURL(file);
    show("preview");
  } else show("preview", false);

  busy("Reading your parchi… (10–30 sec)");
  try {
    const upload = await shrinkImage(file);
    if (upload.size > 4 * 1024 * 1024) throw new Error("That file is too big (max 4 MB). Try a photo instead of a large PDF.");
    const fd = new FormData();
    fd.append("image", upload, upload.name || "parchi.jpg");
    const { raw_text } = await api("/api/read", { method: "POST", body: fd });
    state.rawText = raw_text;
    $("raw").value = raw_text;
    show("raw-wrap");
    if (!raw_text || raw_text.trim().length < 5) {
      busy(null);
      $("raw-wrap").open = true;
      throw new Error("Couldn't read much from this photo. Try a clearer, well-lit photo — or type the prescription below and tap “Explain again”.");
    }
    await explain();
  } catch (e) { fail(e); }
}

// Downscale photos in the browser (~1600px JPEG): faster uploads and under the host's 4.5 MB body limit.
async function shrinkImage(file) {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.88));
    return blob ? new File([blob], "parchi.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file; // e.g. HEIC on browsers that can't decode it: the server converts it
  }
}

function resetResults() {
  stopAudio();
  state.rx = null;
  ["error", "listen", "schedule", "ask", "raw-wrap"].forEach((id) => show(id, false));
  $("chat").innerHTML = "";
}

// ---------- step 2: text -> structure + spoken summary ----------
async function explain() {
  const raw = $("raw").value.trim() || state.rawText;
  if (!raw) return;
  busy("Understanding the medicines…");
  show("error", false);
  try {
    const [data] = await Promise.all([
      postJSON("/api/explain", { raw_text: raw, lang: state.lang }),
      loadLabels(),
    ]);
    state.rx = data.rx;
    state.summary = data.summary;
    renderSchedule();
    $("summary").textContent = data.summary || "";
    show("listen", !!data.summary);
    show("schedule");
    show("ask");
    busy(null);
    if (data.summary) speak(data.summary, $("play")); // the app starts talking
  } catch (e) { fail(e); }
}

async function loadLabels() {
  try { state.labels = await postJSON("/api/labels", { labels: EN_LABELS, lang: state.lang }); }
  catch { state.labels = null; }
  applyLabels();
}
function applyLabels() {
  const map = {
    "l-title": "title", "l-medicine": "medicine", "l-morning": "morning", "l-afternoon": "afternoon",
    "l-night": "night", "l-food": "food", "l-days": "days", "l-disclaimer": "disclaimer",
    "l-share": "share", "mic-label": "hold", "play-label": "listen",
  };
  for (const [id, k] of Object.entries(map)) $(id).textContent = L(k);
}

// ---------- step 3: schedule card ----------
function foodText(f) { return f ? L(f) : "—"; }

function medLine(m) {
  // short spoken line for one medicine, built from the structured data
  const parts = [m.name];
  if (m.purpose_simple) parts.push(`(${m.purpose_simple})`);
  if (m.dose) parts.push(m.dose);
  const when = [m.morning && L("morning"), m.afternoon && L("afternoon"), m.night && L("night")].filter(Boolean);
  if (m.when_needed) when.push(L("whenNeeded"));
  if (when.length) parts.push(when.join(", "));
  if (m.food) parts.push(L(m.food));
  if (m.days) parts.push(`${m.days} ${L("days")}`);
  if (m.confidence === "low") parts.push(L("check"));
  return parts.join(" · ");
}

function renderSchedule() {
  const rx = state.rx;
  const meta = [rx.patient, rx.doctor, rx.date].filter(Boolean).join(" · ");
  $("meta").textContent = meta;
  const tbody = $("rows");
  tbody.innerHTML = "";
  const tick = (on) => `<td class="${on ? "yes" : "no"}">${on ? "✓" : "·"}</td>`;

  if (!rx.medicines.length) {
    tbody.innerHTML = `<tr><td colspan="7">No medicines found. Check “What we read” above and fix the text.</td></tr>`;
  }
  rx.medicines.forEach((m, i) => {
    const tr = document.createElement("tr");
    if (m.confidence === "low") tr.className = "low";
    const sub = [m.dose, m.purpose_simple, m.when_needed ? L("whenNeeded") : ""].filter(Boolean).join(" · ");
    tr.innerHTML = `
      <td class="name"><strong></strong><span></span>${m.confidence === "low" ? `<em class="badge">⚠️ ${esc(L("check"))}</em>` : ""}</td>
      ${tick(m.morning)}${tick(m.afternoon)}${tick(m.night)}
      <td class="food">${esc(foodText(m.food))}</td>
      <td class="days">${m.days ?? "—"}</td>
      <td><button class="row-speak" type="button" aria-label="${esc(L("listen"))}">🔊</button></td>`;
    tr.querySelector("strong").textContent = m.name;
    tr.querySelector("span").textContent = sub;
    tr.querySelector(".row-speak").addEventListener("click", (ev) => speak(medLine(m), ev.currentTarget));
    tbody.appendChild(tr);
  });

  const extras = $("extras");
  extras.innerHTML = "";
  const add = (label, items, cls) => {
    if (!items || !items.length) return;
    const li = document.createElement("li");
    if (cls) li.className = cls;
    li.textContent = `${label}: ${items.join(", ")}`;
    extras.appendChild(li);
  };
  add(L("tests"), rx.tests);
  add(L("advice"), rx.advice);
  add("⚠️ " + L("unclear"), rx.unclear, "warn");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Plain text only: emoji/symbols render as boxes on systems without an emoji font.
function shareText() {
  const rx = state.rx;
  const lines = [`*${L("title")}*${rx.patient ? " - " + rx.patient : ""}`, ""];
  rx.medicines.forEach((m, i) => {
    lines.push(`${i + 1}. *${m.name}*${m.dose ? " - " + m.dose : ""}`);
    const when = [m.morning && L("morning"), m.afternoon && L("afternoon"), m.night && L("night")].filter(Boolean);
    if (when.length) lines.push(`   ${when.join(", ")}`);
    const bits = [m.food && L(m.food), m.days && `${m.days} ${L("days")}`, m.when_needed && L("whenNeeded")].filter(Boolean);
    if (bits.length) lines.push(`   ${bits.join(", ")}`);
    if (m.confidence === "low") lines.push(`   (${L("check")})`);
  });
  if (rx.tests && rx.tests.length) lines.push("", `${L("tests")}: ${rx.tests.join(", ")}`);
  lines.push("", L("disclaimer"), "- Parchi");
  return lines.join("\n");
}

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

$("share").addEventListener("click", async () => {
  if (!state.rx) return;
  const text = shareText();
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard is a bonus */ }
  if (isMobile) {
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    window.location.href = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
  } else {
    // Desktop: go straight to WhatsApp Web (wa.me shows a "download" landing page on desktop).
    window.open("https://web.whatsapp.com/send?text=" + encodeURIComponent(text), "_blank", "noopener");
  }
});

// ---------- step 4: hold-to-ask ----------
const mic = $("mic");
let rec = null, chunks = [], recTimer = null, wantStop = false, stream = null;

async function startRec(ev) {
  ev.preventDefault();
  if (rec || mic.disabled || !state.rx) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return fail(new Error("Voice recording needs a modern browser on https or localhost."));
  }
  stopAudio();
  wantStop = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return fail(new Error("Microphone permission was denied."));
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = onRecStop;
  rec.start();
  mic.classList.add("rec");
  $("mic-label").textContent = L("release");
  recTimer = setTimeout(stopRec, 25000); // STT limit is 30s
  if (wantStop) stopRec(); // released while permission prompt was open
}

function stopRec() {
  wantStop = true;
  clearTimeout(recTimer);
  if (rec && rec.state === "recording") rec.stop();
}

async function onRecStop() {
  stream.getTracks().forEach((t) => t.stop());
  mic.classList.remove("rec");
  $("mic-label").textContent = L("hold");
  const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
  rec = null;
  if (blob.size < 1000) return fail(new Error("Too short — hold the button while you speak."));

  mic.disabled = true;
  busy("Listening…");
  try {
    const fd = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    fd.append("audio", new File([blob], `q.${ext}`, { type: blob.type.split(";")[0] }));
    fd.append("rx", JSON.stringify(state.rx));
    fd.append("lang", state.lang);
    const r = await api("/api/ask", { method: "POST", body: fd });
    busy(null);
    bubble("q", r.question);
    const a = bubble("a", "🔊 " + r.answer);
    a.addEventListener("click", () => playClips(r.clips));
    playClips(r.clips);
  } catch (e) { fail(e); }
  finally { mic.disabled = false; }
}

function bubble(kind, text) {
  const d = document.createElement("div");
  d.className = "bubble " + kind;
  d.textContent = text;
  $("chat").appendChild(d);
  d.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return d;
}

mic.addEventListener("pointerdown", startRec);
["pointerup", "pointerleave", "pointercancel"].forEach((e) => mic.addEventListener(e, stopRec));
mic.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- wiring ----------
$("photo").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });
$("photo-gallery").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });
$("sample").addEventListener("click", async () => {
  const blob = await (await fetch("/static/sample.jpg")).blob();
  handleFile(new File([blob], "sample.jpg", { type: "image/jpeg" }));
});
$("reexplain").addEventListener("click", explain);
$("play").addEventListener("click", (e) => {
  if (!player.paused) return stopAudio();
  speak(state.summary, e.currentTarget);
});

try { const saved = localStorage.getItem("parchi-lang"); if (saved) $("lang").value = saved; } catch { /* ignore */ }
state.lang = $("lang").value;
$("lang").addEventListener("change", (e) => {
  state.lang = e.target.value;
  try { localStorage.setItem("parchi-lang", state.lang); } catch { /* ignore */ }
  if (state.rx) explain(); // re-explain in the new language
  else loadLabels();
});
loadLabels();
