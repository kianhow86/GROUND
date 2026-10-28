// Shared plan helpers for Ground's functions: who is Pro, and is free use paused this month.
// Pro passes live in the "ground-codes" store as  pass:<device token> = { until, code }.
const { getStore } = require("@netlify/blobs");

function isOwner(event) {
  const k = process.env.OWNER_KEY || "";
  return !!k && String(event.headers["x-owner-key"] || "").trim() === k;
}

function cleanToken(t) { return String(t || "").replace(/[^a-z0-9_]/g, "").slice(0, 32); }

// Returns the pass end (ms) for this device, or 0.
async function proUntil(token) {
  token = cleanToken(token);
  if (!token) return 0;
  try {
    const raw = await getStore("ground-codes").get("pass:" + token);
    if (!raw) return 0;
    const p = JSON.parse(raw);
    const t = Date.parse(p.until || "");
    return isFinite(t) ? t : 0;
  } catch (e) { return 0; }
}

async function tierOf(event, token) {
  if (isOwner(event)) return "pro";
  return (await proUntil(token)) > Date.now() ? "pro" : "lite";
}

// Monthly AI spend so far (Anthropic tokens, Sonnet prices). Cached for a minute per warm function.
let _spend = { at: 0, usd: 0 };
async function monthSpendUSD() {
  if (Date.now() - _spend.at < 60000) return _spend.usd;
  let usd = 0;
  try {
    const d = new Date();
    const key = `_all:tok:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const raw = await getStore("ground-usage").get(key);
    if (raw) { const a = JSON.parse(raw); usd = (a.in || 0) * 3e-6 + (a.out || 0) * 15e-6; }
  } catch (e) { usd = _spend.usd; }
  _spend = { at: Date.now(), usd };
  return usd;
}

// Free use pauses at 80% of the monthly budget (GROUND_BUDGET, USD, default 40). Pro is never paused.
async function freePaused() {
  const budget = parseFloat(process.env.GROUND_BUDGET || "40") || 40;
  return (await monthSpendUSD()) >= budget * 0.8;
}

module.exports = { isOwner, cleanToken, proUntil, tierOf, freePaused, monthSpendUSD };
