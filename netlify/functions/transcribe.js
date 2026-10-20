// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/transcribe — audio in (webm/mp4), transcript out.
// The main transcript for every recording (handles street noise far better than live captions). gpt-4o-mini-transcribe, falling back to whisper-1;
// set TRANSCRIBE_PROVIDER=none to turn it off (the app then keeps the captions).
// Headers: X-Client-Token (device), X-Lang (auto|en|zh|…) as a hint.
// ═══════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  const origin = event.headers["origin"] || "";
  const allowed = ["https://ground.kianhow.com", "https://groundbykianhow.netlify.app", "http://localhost:8888", "http://localhost:3000"];
  const h = { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, X-Owner-Key, X-Lang", "Access-Control-Allow-Methods": "POST, OPTIONS", "content-type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: h, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: h, body: JSON.stringify({ error: "method_not_allowed" }) };
  const key = process.env.OPENAI_API_KEY;
  if (!key || process.env.TRANSCRIBE_PROVIDER === "none") return { statusCode: 503, headers: h, body: JSON.stringify({ error: "transcription_off" }) };
  try {
    const buf = Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8");
    if (buf.length < 2000) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "too_short" }) };
    if (buf.length > 24 * 1024 * 1024) return { statusCode: 413, headers: h, body: JSON.stringify({ error: "too_large" }) };
    const mime = (event.headers["content-type"] || "audio/webm").split(";")[0];
    const ext = /mp4|m4a|aac/.test(mime) ? "mp4" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "webm";
    const lang = (event.headers["x-lang"] || "auto").toLowerCase();
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: mime }), "answer." + ext);
    const model = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"; // better than whisper-1 in noisy places
    fd.append("model", model);
    fd.append("response_format", "json");
    // Steer numbers: "six thousand five" means 6,500, not 6005
    fd.append("prompt", "Prices are written in figures: 6,500, 8,000, 12,500, 3.5k. Six thousand five means 6,500.");
    if (lang && lang !== "auto") fd.append("language", lang.split("-")[0] === "yue" ? "zh" : lang.split("-")[0]);
    let r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
    if (!r.ok && model !== "whisper-1") { fd.set("model", "whisper-1"); r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd }); }
    const text = await r.text();
    if (!r.ok) return { statusCode: 502, headers: h, body: JSON.stringify({ error: "whisper_" + r.status, detail: text.slice(0, 200) }) };
    const j = JSON.parse(text);
    return { statusCode: 200, headers: h, body: JSON.stringify({ transcript: String(j.text || "").trim() }) };
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: "transcribe_failed", detail: String(e.message || e).slice(0, 200) }) };
  }
};
