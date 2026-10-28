// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/tts — text in, natural speech (mp3) out.
// OpenAI gpt-4o-mini-tts, which takes an "instructions" line for tone, so the
// client in a price talk can sound skeptical and K can sound like a coach.
// Needs OPENAI_API_KEY (the same key as the Whisper fallback). Without it, or with
// TTS_PROVIDER=none, this returns 503 and the app falls back to the phone's own voice.
// Body: { text, voice, style }  Headers: X-Client-Token, X-Owner-Key
// Limit: TTS_DAILY_LIMIT lines per device per day (default 150). Owner: no limit.
// ═══════════════════════════════════════════════════════════════════════════
const { getStore, connectLambda } = require("@netlify/blobs");
const plan = require("../lib/plan");
const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

exports.handler = async (event) => {
  try { if (typeof connectLambda === "function") connectLambda(event); } catch (e) {}
  const origin = event.headers["origin"] || "";
  const allowed = ["https://ground.kianhow.com", "https://groundbykianhow.netlify.app", "http://localhost:8888", "http://localhost:3000"];
  const h = { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, X-Owner-Key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (code, o) => ({ statusCode: code, headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(o) });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: h, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  const key = process.env.OPENAI_API_KEY;
  if (!key || process.env.TTS_PROVIDER === "none") return json(503, { error: "tts_off" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad_json" }); }
  const text = String(body.text || "").trim().slice(0, 700);
  if (!text) return json(400, { error: "no_text" });
  const voice = VOICES.includes(body.voice) ? body.voice : "ash";
  const style = String(body.style || "").slice(0, 300);

  // Per-device daily limit (best effort: if Blobs fails, still speak)
  const owner = process.env.OWNER_KEY && event.headers["x-owner-key"] === process.env.OWNER_KEY;
  const token = String(event.headers["x-client-token"] || "").slice(0, 40);
  if (!owner) {
    if (!/^grd_[a-z0-9]{8,}$/.test(token)) return json(401, { error: "no_token" });
    // Characters' voices are a Pro feature.
    if ((await plan.tierOf(event, token)) !== "pro") return json(403, { error: "pro_only" });
    try {
      const store = getStore("ground-usage");
      const day = new Date().toISOString().slice(0, 10);
      const k = "tts:" + day + ":" + token;
      const n = parseInt((await store.get(k)) || "0", 10);
      const limit = parseInt(process.env.TTS_DAILY_LIMIT || "150", 10);
      if (n >= limit) return json(429, { error: "tts_limit" });
      await store.set(k, String(n + 1));
    } catch (e) {}
  }

  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
        voice, input: text, response_format: "mp3",
        instructions: (style ? style + " " : "") + "Sound like a real person talking, not someone reading: natural pace, small pauses, conversational intonation."
      })
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return json(502, { error: "tts_" + r.status, detail: t.slice(0, 200) }); }
    const buf = Buffer.from(await r.arrayBuffer());
    return { statusCode: 200, headers: { ...h, "content-type": "audio/mpeg", "cache-control": "no-store" }, body: buf.toString("base64"), isBase64Encoded: true };
  } catch (e) {
    return json(500, { error: "tts_failed", detail: String(e.message || e).slice(0, 200) });
  }
};
