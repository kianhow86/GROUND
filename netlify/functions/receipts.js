// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/receipts: WeChat Pay receipts. Nothing can check a personal WeChat payment,
// so the buyer sends a screenshot and the owner approves it in one tap; the pass then turns on by itself.
//   POST {plan:"m"|"q", image:"data:image/jpeg;base64,…"}   buyer sends a receipt → {id}
//   GET                                                     buyer: my latest receipt → {status, plan} or {}
//   GET  ?owner=1                                           owner: receipts waiting, with images
//   POST ?owner=1 {id, act:"approve"|"reject"}              owner decides
// ═══════════════════════════════════════════════════════════════════════════
const { getStore, connectLambda } = require("@netlify/blobs");
const plan = require("../lib/plan");
const { grantPass } = require("../lib/grant");
const DAYS = { m: 30, q: 90 }, CNY = { m: "¥98", q: "¥238" };
function cors(origin) {
  const allowed = ["https://groundbykian.netlify.app", "https://groundbykianhow.netlify.app", "http://localhost:8888", "http://localhost:3000"];
  return { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, X-Owner-Key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "content-type": "application/json" };
}
exports.handler = async (event) => {
  try { if (typeof connectLambda === "function") connectLambda(event); } catch (e) {}
  const h = cors(event.headers["origin"] || "");
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: h, body: "" };
  const reply = (s, o) => ({ statusCode: s, headers: h, body: JSON.stringify(o) });
  let store; try { store = getStore("ground-pay"); } catch (e) { return reply(500, { error: "store_unavailable" }); }
  const isOwner = plan.isOwner(event);
  const token = plan.cleanToken(event.headers["x-client-token"]);
  const owner = /(^|[?&])owner=1/.test(event.rawQuery || "") || (event.queryStringParameters || {}).owner === "1";
  const readJ = async k => { try { const raw = await store.get(k); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
  const pending = async () => (await readJ("_pending")) || [];

  if (owner) {
    if (!isOwner) return reply(404, { error: "not_found" });
    if (event.httpMethod === "GET") {
      const ids = await pending(), out = [];
      for (const id of ids.slice(0, 30)) { const r = await readJ("rcpt:" + id); if (r && r.status === "pending") out.push({ ...r, image: await store.get("img:" + id) }); }
      return reply(200, { receipts: out });
    }
    if (event.httpMethod === "POST") {
      let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad_json" }); }
      const r = await readJ("rcpt:" + String(b.id || "").replace(/[^a-z0-9]/g, ""));
      if (!r) return reply(404, { error: "not_found" });
      if (r.status === "pending") {
        if (b.act === "approve") { const g = await grantPass(r.token, DAYS[r.plan], "wechat:" + r.id); Object.assign(r, { status: "approved", code: g.code, until: g.until }); }
        else if (b.act === "reject") r.status = "rejected";
        else return reply(400, { error: "bad_act" });
        r.decidedAt = new Date().toISOString();
        await store.set("rcpt:" + r.id, JSON.stringify(r));
        await store.set("_pending", JSON.stringify((await pending()).filter(x => x !== r.id)));
        try { await store.delete("img:" + r.id); } catch (e) {}
      }
      return reply(200, { ok: true, status: r.status });
    }
    return reply(405, { error: "method_not_allowed" });
  }
  if (!token) return reply(400, { error: "no_device" });
  if (event.httpMethod === "GET") {
    const id = (await readJ("dev:" + token)) || null;
    if (!id) return reply(200, {});
    const r = await readJ("rcpt:" + id);
    return reply(200, r ? { id: r.id, status: r.status, plan: r.plan, at: r.at } : {});
  }
  if (event.httpMethod === "POST") {
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad_json" }); }
    if (!DAYS[b.plan]) return reply(400, { error: "bad_plan" });
    const img = String(b.image || "");
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 1400000) return reply(400, { error: "bad_image" });
    // One receipt waiting per device: a new one replaces the old.
    const prev = await readJ("dev:" + token);
    let list = await pending();
    if (prev) { const pr = await readJ("rcpt:" + prev); if (pr && pr.status === "pending") { list = list.filter(x => x !== prev); try { await store.delete("img:" + prev); } catch (e) {} await store.set("rcpt:" + prev, JSON.stringify({ ...pr, status: "replaced" })); } }
    if (list.length >= 200) return reply(429, { error: "too_many" });
    const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const r = { id, token, plan: b.plan, cny: CNY[b.plan], at: new Date().toISOString(), status: "pending" };
    await store.set("img:" + id, img);
    await store.set("rcpt:" + id, JSON.stringify(r));
    await store.set("dev:" + token, JSON.stringify(id));
    list.unshift(id);
    await store.set("_pending", JSON.stringify(list));
    return reply(200, { id, status: "pending" });
  }
  return reply(405, { error: "method_not_allowed" });
};
