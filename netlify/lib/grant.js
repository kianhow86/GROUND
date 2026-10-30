// Give a device a Pro pass without anyone typing a code: used by PayPal checkout and approved WeChat receipts.
// It mints a code like the owner page does, marks it used by this device and extends the pass,
// so the buyer still has a code to keep for another phone or a reinstall.
const { getStore } = require("@netlify/blobs");
const plan = require("./plan");
const ALPH = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
function mint() { let s = ""; for (let i = 0; i < 6; i++) s += ALPH[Math.floor(Math.random() * ALPH.length)]; return "GRD-" + s.slice(0, 4) + "-" + s.slice(4); }

async function grantPass(token, days, source) {
  token = plan.cleanToken(token);
  if (!token || !days) throw new Error("bad_grant");
  const store = getStore("ground-codes");
  let index = [];
  try { const raw = await store.get("_index"); index = raw ? JSON.parse(raw) : []; } catch (e) {}
  let code = mint(), guard = 0;
  while (index.includes(code) && guard++ < 20) code = mint();
  const now = new Date().toISOString();
  // The code is already used by this device; it can't be passed on to someone else.
  const c = { code, sessions: 0, days, expires: null, made: now, usedBy: token, usedAt: now, source: source || "" };
  await store.set("code:" + code, JSON.stringify(c));
  index.unshift(code);
  await store.set("_index", JSON.stringify(index.slice(0, 2000)));
  const cur = await plan.proUntil(token);
  const base = cur > Date.now() ? cur : Date.now();
  const until = new Date(base + days * 86400000).toISOString();
  await store.set("pass:" + token, JSON.stringify({ until, code, at: now }));
  try { const raw = await store.get("dev:" + token); const d = raw ? JSON.parse(raw) : { codes: [] }; d.codes.push({ code, sessions: 0, at: now, source }); await store.set("dev:" + token, JSON.stringify(d)); } catch (e) {}
  return { code, until, days };
}
module.exports = { grantPass };
