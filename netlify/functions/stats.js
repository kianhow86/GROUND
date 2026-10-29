// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/stats — anonymous counters for product decisions.
// POST {e:"sugA_shown"} adds one to this month's count for that event.
// No names, no text, no device ids: only event names and counts.
// GET (header X-Owner-Key = OWNER_KEY) returns this month and last month.
// ═══════════════════════════════════════════════════════════════════════════
const { getStore, connectLambda } = require("@netlify/blobs");
exports.handler = async (event) => {
  try { if (typeof connectLambda === "function") connectLambda(event); } catch (e) {}
  const origin = event.headers["origin"] || "";
  const allowed = ["https://groundbykian.netlify.app", "https://ground.kianhow.com", "https://groundbykianhow.netlify.app", "http://localhost:8888", "http://localhost:3000"];
  const h = { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Access-Control-Allow-Headers": "Content-Type, X-Owner-Key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "content-type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: h, body: "" };
  const month = (d) => d.toISOString().slice(0, 7);
  let store; try { store = getStore("ground-stats"); } catch (e) { return { statusCode: 503, headers: h, body: JSON.stringify({ error: "store" }) }; }
  if (event.httpMethod === "POST") {
    let e = ""; try { e = String(JSON.parse(event.body || "{}").e || ""); } catch (x) {}
    if (!/^[A-Za-z_]{3,30}$/.test(e)) return { statusCode: 400, headers: h, body: JSON.stringify({ error: "bad_event" }) };
    const k = "m:" + month(new Date());
    try { const cur = JSON.parse((await store.get(k)) || "{}"); cur[e] = (cur[e] || 0) + 1; await store.set(k, JSON.stringify(cur)); } catch (x) {}
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true }) };
  }
  if (event.httpMethod === "GET") {
    if (!process.env.OWNER_KEY || event.headers["x-owner-key"] !== process.env.OWNER_KEY) return { statusCode: 403, headers: h, body: JSON.stringify({ error: "owner_only" }) };
    const now = new Date(), prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const read = async (m) => { try { return JSON.parse((await store.get("m:" + m)) || "{}"); } catch (x) { return {}; } };
    return { statusCode: 200, headers: h, body: JSON.stringify({ month: month(now), now: await read(month(now)), prevMonth: month(prev), prev: await read(month(prev)) }) };
  }
  return { statusCode: 405, headers: h, body: JSON.stringify({ error: "method" }) };
};
