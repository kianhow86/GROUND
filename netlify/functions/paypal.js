// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/paypal: PayPal checkout that turns Pro on by itself.
//   GET                                 {clientId, env}  (clientId null = not set up: the app falls back to links)
//   POST {action:"create", plan:"m"|"q"}  creates a PayPal order for this device  → {id}
//   POST {action:"capture", orderId}      takes the payment, checks it, gives the pass → {code, until, days}
// Needs PAYPAL_CLIENT_ID and PAYPAL_SECRET in Netlify. PAYPAL_ENV=live for real money; anything else is sandbox.
// ═══════════════════════════════════════════════════════════════════════════
const { getStore, connectLambda } = require("@netlify/blobs");
const plan = require("../lib/plan");
const { grantPass } = require("../lib/grant");
const PLANS = { m: { usd: "15.00", days: 30, name: "Ground Pro · 30 days" }, q: { usd: "36.00", days: 90, name: "Ground Pro · 90 days" } };
function cors(origin) {
  const allowed = ["https://groundbykian.netlify.app", "https://groundbykianhow.netlify.app", "http://localhost:8888", "http://localhost:3000"];
  return { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Access-Control-Allow-Headers": "Content-Type, X-Client-Token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "content-type": "application/json" };
}
const API = () => (process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
async function accessToken() {
  const id = process.env.PAYPAL_CLIENT_ID, sec = process.env.PAYPAL_SECRET;
  const r = await fetch(API() + "/v1/oauth2/token", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(id + ":" + sec).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  if (!r.ok) throw new Error("paypal_auth_" + r.status);
  return (await r.json()).access_token;
}
exports.handler = async (event) => {
  try { if (typeof connectLambda === "function") connectLambda(event); } catch (e) {}
  const h = cors(event.headers["origin"] || "");
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: h, body: "" };
  const reply = (s, o) => ({ statusCode: s, headers: h, body: JSON.stringify(o) });
  const ready = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
  if (event.httpMethod === "GET") return reply(200, { clientId: ready ? process.env.PAYPAL_CLIENT_ID : null, env: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox" });
  if (event.httpMethod !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!ready) return reply(503, { error: "paypal_not_set_up" });
  const token = plan.cleanToken(event.headers["x-client-token"]);
  if (!token) return reply(400, { error: "no_device" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad_json" }); }
  let store; try { store = getStore("ground-pay"); } catch (e) { return reply(500, { error: "store_unavailable" }); }
  try {
    if (body.action === "create") {
      const p = PLANS[body.plan]; if (!p) return reply(400, { error: "bad_plan" });
      const at = await accessToken();
      const r = await fetch(API() + "/v2/checkout/orders", { method: "POST", headers: { Authorization: "Bearer " + at, "content-type": "application/json" },
        body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ description: p.name, custom_id: token + ":" + body.plan, amount: { currency_code: "USD", value: p.usd } }],
          application_context: { brand_name: "Ground by Kian How", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } }) });
      const j = await r.json();
      if (!r.ok || !j.id) return reply(502, { error: "paypal_create_failed", detail: j && (j.name || j.message) });
      await store.set("order:" + j.id, JSON.stringify({ token, plan: body.plan, at: new Date().toISOString(), state: "created" }));
      return reply(200, { id: j.id });
    }
    if (body.action === "capture") {
      const id = String(body.orderId || "").replace(/[^A-Z0-9]/gi, "").slice(0, 40);
      if (!id) return reply(400, { error: "bad_order" });
      let rec = null; try { const raw = await store.get("order:" + id); rec = raw ? JSON.parse(raw) : null; } catch (e) {}
      if (!rec || rec.token !== token) return reply(404, { error: "unknown_order" });
      if (rec.state === "granted") return reply(200, { code: rec.code, until: rec.until, days: rec.days });   // asked twice: same answer
      const at = await accessToken();
      let r = await fetch(API() + "/v2/checkout/orders/" + id + "/capture", { method: "POST", headers: { Authorization: "Bearer " + at, "content-type": "application/json" } });
      let j = await r.json();
      if (!r.ok && j && Array.isArray(j.details) && j.details.some(d => d.issue === "ORDER_ALREADY_CAPTURED")) {
        r = await fetch(API() + "/v2/checkout/orders/" + id, { headers: { Authorization: "Bearer " + at } }); j = await r.json();
      }
      if (!r.ok) return reply(402, { error: "paypal_declined", detail: j && (j.details && j.details[0] && j.details[0].issue || j.name) });
      const pu = (j.purchase_units || [])[0] || {};
      const cap = ((pu.payments || {}).captures || [])[0] || {};
      const p = PLANS[rec.plan];
      const amt = cap.amount || pu.amount || {};
      if (j.status !== "COMPLETED" || cap.status !== "COMPLETED") return reply(402, { error: "not_completed", status: cap.status || j.status });
      if (amt.currency_code !== "USD" || amt.value !== p.usd) return reply(402, { error: "wrong_amount" });
      if ((cap.custom_id || pu.custom_id) && (cap.custom_id || pu.custom_id) !== token + ":" + rec.plan) return reply(402, { error: "not_this_device" });
      // Asked twice at the same moment? The first one to get here gives the pass.
      { const again = await store.get("order:" + id); if (again && JSON.parse(again).state === "granted") { const a = JSON.parse(again); return reply(200, { code: a.code, until: a.until, days: a.days }); } }
      const g = await grantPass(token, p.days, "paypal:" + id);
      const email = (j.payer && j.payer.email_address) || "";
      await store.set("order:" + id, JSON.stringify({ ...rec, state: "granted", code: g.code, until: g.until, days: g.days, email, capture: cap.id, paidAt: new Date().toISOString() }));
      return reply(200, g);
    }
    return reply(400, { error: "bad_action" });
  } catch (e) {
    console.error("paypal:", e.message);
    return reply(502, { error: "paypal_unreachable" });
  }
};
