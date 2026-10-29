// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/sync — the encrypted notebook, one blob per sync id.
// The id is SHA-256 of the sync code (done on the device); the data is AES-GCM
// encrypted on the device. This function only stores and hands back bytes.
//   GET    ?id=<hex>[&have=<rev>]  → {rev, data} or {rev, same:true} or 404 {error:"not_found"}
//   POST   {id, base, data}        → {rev}; 409 {rev} when base is stale
//   DELETE ?id=<hex>               → {ok}
// ═══════════════════════════════════════════════════════════════════════════
const { getStore, connectLambda } = require("@netlify/blobs");
exports.handler = async (event) => {
  try { if (typeof connectLambda === "function") connectLambda(event); } catch (e) {}
  const origin = event.headers["origin"] || "";
  const allowed = ["https://groundbykian.netlify.app", "https://ground.kianhow.com", "https://groundbykianhow.netlify.app", "http://localhost:8888", "http://localhost:3000"];
  const h = { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "content-type": "application/json", "cache-control": "no-store" };
  const reply = (s, o) => ({ statusCode: s, headers: h, body: JSON.stringify(o) });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: h, body: "" };
  let store; try { store = getStore("ground-sync"); } catch (e) { return reply(500, { error: "store_unavailable" }); }
  const q = event.queryStringParameters || {};
  const okId = (id) => /^[0-9a-f]{64}$/.test(String(id || ""));
  const read = async (id) => { try { const raw = await store.get("nb:" + id); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
  if (event.httpMethod === "GET") {
    if (!okId(q.id)) return reply(400, { error: "bad_id" });
    const rec = await read(q.id);
    if (!rec) return reply(404, { error: "not_found" });
    if (q.have && parseInt(q.have, 10) === rec.rev) return reply(200, { rev: rec.rev, same: true });
    return reply(200, { rev: rec.rev, data: rec.data });
  }
  if (event.httpMethod === "POST") {
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad_json" }); }
    if (!okId(body.id) || typeof body.data !== "string") return reply(400, { error: "bad_request" });
    if (body.data.length > 2 * 1024 * 1024) return reply(413, { error: "too_large" });
    const rec = await read(body.id);
    const base = parseInt(body.base, 10) || 0;
    if (rec && rec.rev !== base) return reply(409, { rev: rec.rev });
    const next = { rev: (rec ? rec.rev : 0) + 1, data: body.data, at: new Date().toISOString() };
    await store.set("nb:" + body.id, JSON.stringify(next));
    return reply(200, { rev: next.rev });
  }
  if (event.httpMethod === "DELETE") {
    if (!okId(q.id)) return reply(400, { error: "bad_id" });
    try { await store.delete("nb:" + q.id); } catch (e) {}
    return reply(200, { ok: true });
  }
  return reply(405, { error: "method_not_allowed" });
};
