// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/codes — unlock codes for Ground
//   POST {code}            redeem: binds the code to the caller's device token (X-Client-Token),
//                          adds its sessions. Each code works on one device.
//   GET  ?owner=1          list codes (owner only: X-Owner-Key = OWNER_KEY)
//   PUT  ?owner=1 {sessions,count,days}   make codes (owner only)
// Codes look like GRD-7KQ2-M9 and live in Netlify Blobs store "ground-codes".
// ═══════════════════════════════════════════════════════════════════════════
const { getStore, connectLambda } = require("@netlify/blobs");
const ALPH = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
function mint() { let s = ""; for (let i = 0; i < 6; i++) s += ALPH[Math.floor(Math.random() * ALPH.length)]; return "GRD-" + s.slice(0, 4) + "-" + s.slice(4); }
function cors(origin) {
  const allowed = ["https://ground.kianhow.com", "https://groundbykianhow.netlify.app", "http://localhost:8888", "http://localhost:3000"];
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, X-Owner-Key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "content-type": "application/json"
  };
}
exports.handler = async (event) => {
  try { if (typeof connectLambda === "function") connectLambda(event); } catch (e) {}
  const h = cors(event.headers["origin"] || "");
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: h, body: "" };
  const reply = (status, obj) => ({ statusCode: status, headers: h, body: JSON.stringify(obj) });
  let store;
  try { store = getStore("ground-codes"); } catch (e) { return reply(500, { error: "store_unavailable" }); }
  const ownerKey = process.env.OWNER_KEY || "";
  const isOwner = !!ownerKey && (event.headers["x-owner-key"] || "").trim() === ownerKey;
  const token = (event.headers["x-client-token"] || "").replace(/[^a-z0-9_]/g, "").slice(0, 32);
  const readIndex = async () => { try { const raw = await store.get("_index"); return raw ? JSON.parse(raw) : []; } catch (e) { return []; } };
  const readCode = async (c) => { try { const raw = await store.get("code:" + c); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
  const status = (c) => c.usedBy ? "used" : (c.expires && new Date(c.expires) < new Date() ? "expired" : "unused");

  if (event.httpMethod === "POST") {
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad_json" }); }
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const norm = code.length === 9 && code.startsWith("GRD") ? "GRD-" + code.slice(3, 7) + "-" + code.slice(7) : null;
    if (!norm || !token) return reply(404, { error: "not_found" });
    const c = await readCode(norm);
    if (!c) return reply(404, { error: "not_found" });
    const st = status(c);
    if (st === "used") return reply(409, { error: c.usedBy === token ? "already_yours" : "used" });
    if (st === "expired") return reply(410, { error: "expired", expires: c.expires });
    c.usedBy = token; c.usedAt = new Date().toISOString();
    await store.set("code:" + norm, JSON.stringify(c));
    // Note the credit against the device too, so a reinstall can be reconciled by hand
    try { const raw = await store.get("dev:" + token); const d = raw ? JSON.parse(raw) : { codes: [] }; d.codes.push({ code: norm, sessions: c.sessions, at: c.usedAt }); await store.set("dev:" + token, JSON.stringify(d)); } catch (e) {}
    return reply(200, { ok: true, code: norm, sessions: c.sessions });
  }
  if (!isOwner) return reply(404, { error: "not_found" });
  if (event.httpMethod === "PUT") {
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad_json" }); }
    const sessions = Math.max(1, Math.min(500, parseInt(body.sessions, 10) || 30));
    const count = Math.max(1, Math.min(50, parseInt(body.count, 10) || 1));
    const days = Math.max(0, Math.min(365, parseInt(body.days, 10) || 0));
    const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    const index = await readIndex();
    const made = [];
    for (let i = 0; i < count; i++) {
      let code = mint(); let guard = 0;
      while (index.includes(code) && guard++ < 20) code = mint();
      const c = { code, sessions, expires, made: new Date().toISOString(), usedBy: null, usedAt: null };
      await store.set("code:" + code, JSON.stringify(c));
      index.unshift(code); made.push(c);
    }
    await store.set("_index", JSON.stringify(index.slice(0, 2000)));
    const all = [];
    for (const code of index.slice(0, 300)) { const c = await readCode(code); if (c) all.push({ ...c, status: status(c) }); }
    return reply(200, { ok: true, made: made.map(c => c.code), codes: all });
  }
  if (event.httpMethod === "GET") {
    const index = await readIndex();
    const all = [];
    for (const code of index.slice(0, 300)) { const c = await readCode(code); if (c) all.push({ ...c, status: status(c) }); }
    return reply(200, { codes: all });
  }
  return reply(405, { error: "method_not_allowed" });
};
