// ═══════════════════════════════════════════════════════════════════════════
// /.netlify/functions/ai
// Proxies requests to Anthropic with token-based rate limiting.
//
// Rate limit strategy:
//   - Each device gets a random token (generated client-side, stored in
//     localStorage). The token is sent in the X-Client-Token header.
//   - If no token is provided, one is assigned and returned in the response.
//   - Usage is tracked per token per calendar month in Netlify Blobs.
//   - Limits are per-feature per day + global per month.
//   - VPN-proof: IP is not used for tracking. Token follows the device.
//
// Ground by KIAN HOW. Daily limits per feature (generous for real users, stops abuse):
//   reply-draft : 10/day  (Help me reply: a draft, or a warmer/firmer/shorter redraft)
//   rw-turn     : 80/day  (Practice a talk + Face the room: scene, the other side's lines, the decision)
//   rw-eval     : 20/day  (Practice a talk: K's notes)
//   pitch-build : 12/day  (Pitch it: K drafts the parts)
//   pitch-notes : 12/day  (Pitch it: K's notes after a run, the room's verdict)
//   quick-eval  : 15/day  (Quick answer: notes + a strong answer)
//   focus-brief : 2/day   (K's line on the hub)
//   nb-note     : 6/day   (K's notebook progress note)
//   default     : 20/day
//
// Each feature now has its own daily counter, so cheap calls (topics, follow-ups)
// no longer use up the budget of K's notes. A conversation already under way sends
// X-Grace: 1 and may go up to GRACE calls past the limit, so it can finish before
// the limit is announced. The owner (X-Owner-Key = OWNER_KEY) has no limits.
//
// Monthly global limit: 400 AI calls per token. The owner (X-Owner-Key) and code holders (see codes.js) are not limited here;
// the app's own session counter and unlock codes decide what a free user can start.
// ═══════════════════════════════════════════════════════════════════════════

const { getStore, connectLambda } = require("@netlify/blobs");
const plan = require("../lib/plan");

const DAILY_LIMITS = {
  "reply-draft": 10,
  "rw-turn":     80,
  "rw-eval":     20,
  "pitch-build": 12,
  "pitch-notes": 12,
  "quick-eval":  15,
  "focus-brief": 2,
  "nb-note":     6,
  "case-adapt":  30,
  "world":       6,
  "desk-route":  30,
  "desk-advice": 15,
  "advice-follow": 30,
  "ask-q":       25,
  "default":     20
};
const GRACE = 8;

const MONTHLY_LIMIT = 400;

// Generate a random token (called server-side for new clients)
function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "grd_";
  for (let i = 0; i < 16; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// Key helpers
function dayKey(token, featureId) {
  const d = new Date();
  return `${token}:day:${featureId ? featureId + ":" : ""}${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}
function monthKey(token) {
  const d = new Date();
  return `${token}:month:${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}
// Token-accounting keys. Separate from the call counters above so the
// rate-limiting logic stays untouched.
function tokKey(token) {
  const d = new Date();
  return `${token}:tok:${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}
// Site-wide aggregate — the number that actually maps to the monthly bill.
function tokKeyGlobal() {
  const d = new Date();
  return `_all:tok:${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}
// Per-feature aggregate — shows which features are driving cost.
function tokKeyFeature(featureId) {
  const d = new Date();
  return `_feat:${featureId}:tok:${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}

// Read {in,out,calls}, add the new usage, write it back.
async function addTokens(store, key, inTok, outTok) {
  let acc = { in: 0, out: 0, calls: 0 };
  try {
    const raw = await store.get(key);
    if (raw) acc = { ...acc, ...JSON.parse(raw) };
  } catch { /* missing or malformed — start fresh */ }
  acc.in    += inTok;
  acc.out   += outTok;
  acc.calls += 1;
  await store.set(key, JSON.stringify(acc));
}

exports.handler = async (event) => {
  // Classic functions must hand the event to Blobs before getStore() works
  try { if (typeof connectLambda === "function") connectLambda(event); } catch (e) { console.error("connectLambda failed:", e.message); }
  // CORS — allow requests from your Netlify domain + localhost dev
  const origin = event.headers["origin"] || "";
  const allowedOrigins = [
    "https://groundbykian.netlify.app",
    "https://ground.kianhow.com",
    "https://groundbykianhow.netlify.app",
    "http://localhost:8888",
    "http://localhost:3000"
  ];
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, X-Feature-Id, X-Owner-Key, X-Grace, X-Practice-Id, X-Taster",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Client-Token, X-Usage-Day, X-Usage-Month, X-Tier"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  // ── Owner-only cost dashboard ──
  // GET /.netlify/functions/ai?stats=<OWNER_KEY> returns this month's token
  // totals with cost already worked out. Read-only, no effect on the AI path.
  if (event.httpMethod === "GET" && event.queryStringParameters?.stats) {
    const ownerKey = process.env.OWNER_KEY;
    if (!ownerKey || event.queryStringParameters.stats !== ownerKey) {
      return { statusCode: 404, headers: corsHeaders, body: "Not found" };
    }
    try {
      const s = getStore("ground-usage");
      const readAcc = async (k) => {
        try {
          const raw = await s.get(k);
          return raw ? JSON.parse(raw) : { in: 0, out: 0, calls: 0 };
        } catch { return { in: 0, out: 0, calls: 0 }; }
      };
      // Sonnet 4.6 pricing, USD per token
      const IN_RATE = 3 / 1e6, OUT_RATE = 15 / 1e6;
      const costOf = (a) => +(a.in * IN_RATE + a.out * OUT_RATE).toFixed(4);

      const total = await readAcc(tokKeyGlobal());
      const features = {};
      for (const f of Object.keys(DAILY_LIMITS)) {
        const a = await readAcc(tokKeyFeature(f));
        if (a.calls > 0) features[f] = { ...a, costUSD: costOf(a) };
      }
      const month = new Date().toISOString().slice(0, 7);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          month,
          total: { ...total, costUSD: costOf(total) },
          avgCostPerCall: total.calls ? +(costOf(total) / total.calls).toFixed(5) : 0,
          byFeature: features
        }, null, 2)
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Stats unavailable: " + err.message })
      };
    }
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method not allowed" };
  }

  // ── Token resolution ──
  let token = (event.headers["x-client-token"] || "").trim();
  const isNewToken = !token || token.length < 10;
  if (isNewToken) token = generateToken();

  // Sanitise: only allow alphanumeric + underscore, max 32 chars
  token = token.replace(/[^a-z0-9_]/g, "").slice(0, 32);
  if (!token) token = generateToken();

  // ── Feature ID for per-feature rate limiting ──
  const featureId = (event.headers["x-feature-id"] || "default").replace(/[^a-z\-]/g, "");
  const dailyLimit = DAILY_LIMITS[featureId] || DAILY_LIMITS["default"];
  const grace = (event.headers["x-grace"] || "") === "1" ? GRACE : 0;
  const _ownerKey = process.env.OWNER_KEY || "";
  const _isOwner = !!_ownerKey && (event.headers["x-owner-key"] || "").trim() === _ownerKey;

  // Pro gets a bigger monthly ceiling: 3 practices a day is ~800 practice calls a month, plus Ask K and replies.
  const tier = _isOwner ? "pro" : await plan.tierOf(event, token);
  const monthlyLimit = tier === "pro" ? 2000 : MONTHLY_LIMIT;

  // ── Rate limit check via Netlify Blobs ──
  let dayUsage = 0, monthUsage = 0;
  let store;
  try {
    store = getStore("ground-usage");
    const dk = dayKey(token, featureId);
    const mk = monthKey(token);

    const [dayRaw, monthRaw] = await Promise.all([
      store.get(dk).catch(() => null),
      store.get(mk).catch(() => null)
    ]);

    dayUsage   = dayRaw   ? parseInt(dayRaw,   10) || 0 : 0;
    monthUsage = monthRaw ? parseInt(monthRaw, 10) || 0 : 0;

    // Check limits
    if (!_isOwner && dayUsage >= dailyLimit + grace) {
      return {
        statusCode: 429,
        headers: {
          ...corsHeaders,
          "X-Client-Token":  token,
          "X-Usage-Day":     String(dayUsage),
          "X-Usage-Month":   String(monthUsage),
          "X-Limit-Day":     String(dailyLimit),
          "X-Limit-Month":   String(MONTHLY_LIMIT),
          "X-Limit-Feature": featureId
        },
        body: JSON.stringify({
          error: "daily_limit_reached",
          feature: featureId,
          used: dayUsage,
          limit: dailyLimit,
          message: `Daily limit reached for this feature (${dayUsage}/${dailyLimit}). Resets at midnight UTC.`
        })
      };
    }

    if (!_isOwner && monthUsage >= monthlyLimit + grace) {
      return {
        statusCode: 429,
        headers: {
          ...corsHeaders,
          "X-Client-Token":  token,
          "X-Usage-Day":     String(dayUsage),
          "X-Usage-Month":   String(monthUsage),
          "X-Limit-Month":   String(MONTHLY_LIMIT)
        },
        body: JSON.stringify({
          error: "monthly_limit_reached",
          used: monthUsage,
          limit: MONTHLY_LIMIT,
          message: `Monthly AI limit reached (${monthUsage}/${MONTHLY_LIMIT}). Resets on the 1st.`
        })
      };
    }
  } catch (blobErr) {
    // If Blobs is unavailable, log and continue — don't block the user
    console.error("Blob store unavailable:", blobErr.message);
  }

  // ── Plans: Lite (free) and Pro ──
  // Lite: generic practice, 1 a day (plus one "your world" taster, ever), Quick answer, nothing else.
  // Pro: 3 practices a day and every feature. A practice is counted once, by the X-Practice-Id the app
  // sends with every call inside it, and a single practice is capped in size.
  const practiceId = String(event.headers["x-practice-id"] || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  const wantTaster = (event.headers["x-taster"] || "") === "1";
  const LITE_OK = { "quick-eval": 6, "focus-brief": 2, "rw-turn": 40 };
  const TASTER_OK = { "world": 4, "case-adapt": 4 };
  const deny = (status, error, extra) => ({
    statusCode: status,
    headers: { ...corsHeaders, "content-type": "application/json", "X-Client-Token": token, "X-Tier": tier },
    body: JSON.stringify({ error, tier, ...(extra || {}) })
  });
  let tasterUsed = false, tasterKey = "taster:" + token;
  if (!_isOwner && store) {
    try { tasterUsed = !!(await store.get(tasterKey)); } catch (e) {}
  }
  if (tier === "lite" && !_isOwner) {
    const tasterCall = wantTaster && !tasterUsed && (TASTER_OK[featureId] || featureId === "rw-turn");
    if (!(featureId in LITE_OK) && !tasterCall) return deny(403, "pro_only", { feature: featureId });
    if (featureId === "rw-turn" && !practiceId) return deny(403, "pro_only", { feature: featureId });
    if (TASTER_OK[featureId] && dayUsage >= TASTER_OK[featureId]) return deny(429, "daily_limit_reached", { feature: featureId });
    if (LITE_OK[featureId] && featureId !== "rw-turn" && dayUsage >= LITE_OK[featureId] + grace) return deny(429, "daily_limit_reached", { feature: featureId, used: dayUsage, limit: LITE_OK[featureId] });
  }
  if ((featureId === "rw-turn" || featureId === "rw-eval") && practiceId && store && !_isOwner) {
    const day = new Date().toISOString().slice(0, 10);
    const pk = "prac:" + token + ":" + day;
    let rec = { ids: [], n: {} };
    try { const raw = await store.get(pk); if (raw) rec = { ids: [], n: {}, ...JSON.parse(raw) }; } catch (e) {}
    if (!rec.ids.includes(practiceId)) {
      // A new practice is starting.
      if (tier === "lite" && await plan.freePaused()) return deny(429, "free_paused");
      const isTaster = tier === "lite" && wantTaster && !tasterUsed;
      const limit = tier === "pro" ? 3 : 1;
      const counted = rec.ids.filter(id => !(rec.taster && rec.taster === id)).length;
      if (!isTaster && counted >= limit) return deny(429, "practice_limit", { used: counted, limit });
      if (tier === "lite") {
        // Soft cap per network, so clearing the browser for fresh free tries runs out.
        const ip = String(event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "").replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45);
        if (ip) {
          const ik = "ipprac:" + ip + ":" + day;
          let ipn = 0;
          try { ipn = parseInt((await store.get(ik)) || "0", 10) || 0; } catch (e) {}
          if (ipn >= 10) return deny(429, "practice_limit", { used: counted, limit });
          try { await store.set(ik, String(ipn + 1)); } catch (e) {}
        }
      }
      rec.ids.push(practiceId);
      if (isTaster) { rec.taster = practiceId; try { await store.set(tasterKey, new Date().toISOString()); } catch (e) {} }
    }
    rec.n[practiceId] = (rec.n[practiceId] || 0) + 1;
    if (rec.n[practiceId] > 18) return deny(429, "practice_long");
    try { await store.set(pk, JSON.stringify(rec)); } catch (e) {}
  } else if (tier === "lite" && !_isOwner && LITE_OK[featureId] && featureId !== "rw-turn" && await plan.freePaused()) {
    return deny(429, "free_paused");
  }

  // ── Parse request body ──
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Invalid JSON body" })
    };
  }

  const { model: _clientModel, max_tokens, system, messages } = body;
  // Structured answers: the app may ask for one forced tool ("answer") so the reply comes back as a parsed object.
  let toolsPart = {};
  if (Array.isArray(body.tools) && body.tools.length === 1 && body.tools[0] && body.tools[0].name === "answer" && body.tools[0].input_schema && body.tools[0].input_schema.type === "object") {
    toolsPart = {
      tools: [{ name: "answer", description: String(body.tools[0].description || "Give your answer.").slice(0, 300), input_schema: body.tools[0].input_schema }],
      tool_choice: { type: "tool", name: "answer" }
    };
  }

  // ── Model enforcement ──
  // Default: lock everyone to Sonnet 4.6 (cost control for pooled backend).
  // Owner bypass: send X-Owner-Key header matching OWNER_KEY env var to
  // unlock any model — including Opus. This header is never exposed in the UI.
  const ownerKey = process.env.OWNER_KEY || "";
  const clientOwnerKey = (event.headers["x-owner-key"] || "").trim();
  const isOwner = ownerKey && clientOwnerKey === ownerKey;

  const model = isOwner
    ? (_clientModel || "claude-sonnet-4-6")  // owner gets whatever they ask for
    : "claude-sonnet-4-6";                   // everyone else gets Sonnet, always

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "messages array is required" })
    };
  }

  // ── Geo-routing: off. Everyone gets Claude; the calls go through this server, so
  // China works too. Set USE_DEEPSEEK_CN=1 to send mainland-China users to DeepSeek again.
  const country = (event.headers["x-nf-geo-country"] || "").toUpperCase();
  const dsKey = process.env.DEEPSEEK_API_KEY;

  if (country === "CN" && dsKey && process.env.USE_DEEPSEEK_CN === "1") {
    // Build DeepSeek messages — system goes as first message in array
    const dsMessages = [];
    if (system) dsMessages.push({ role: "system", content: system });
    dsMessages.push(...messages);

    let dsResp;
    try {
      dsResp = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + dsKey
        },
        body: JSON.stringify({
          model:      "deepseek-chat",
          max_tokens: max_tokens || 1024,
          messages:   dsMessages
        })
      });
    } catch (dsErr) {
      console.error("DeepSeek fetch failed, falling back to Anthropic:", dsErr.message);
    }

    if (dsResp && dsResp.ok) {
      const dsData = await dsResp.json();
      const dsText = dsData.choices?.[0]?.message?.content || "";

      // Normalise to Anthropic response shape — client needs no changes
      const normalised = JSON.stringify({
        id:         dsData.id || ("ds-" + Date.now()),
        type:       "message",
        role:       "assistant",
        content:    [{ type: "text", text: dsText }],
        model:      "deepseek-chat",
        stop_reason:"end_turn",
        usage:      { input_tokens: 0, output_tokens: 0 }
      });

      // Increment usage counters
      if (store) {
        const dk = dayKey(token, featureId);
        const mk = monthKey(token);
        Promise.all([
          store.set(dk, String(dayUsage + 1)),
          store.set(mk, String(monthUsage + 1))
        ]).catch(err => console.error("Usage increment failed:", err.message));
      }

      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          "content-type":   "application/json",
          "X-Client-Token": token,
          "X-Usage-Day":    String(dayUsage + 1),
          "X-Usage-Month":  String(monthUsage + 1),
          "X-Limit-Day":    String(dailyLimit),
          "X-Limit-Month":  String(MONTHLY_LIMIT),
          "X-AI-Provider":  "deepseek"
        },
        body: normalised
      };
    }

    // DeepSeek failed — fall through to Anthropic silently
    console.error("DeepSeek response not ok, falling back to Anthropic");
  }

  // ── Call Anthropic ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Server configuration error: missing API key" })
    };
  }

  let anthropicResp, responseText = "";
  const _t0 = Date.now();
  // One quick retry when Anthropic is busy (overloaded / 5xx), but only while there is time left before the function times out.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type":      "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key":         apiKey
        },
        body: JSON.stringify({
          model:      model      || "claude-sonnet-4-6",
          max_tokens: Math.min(max_tokens || 1024, 4096),
          system:     system     || "",
          messages,
          ...toolsPart
        })
      });
    } catch (fetchErr) {
      if (attempt === 0 && Date.now() - _t0 < 3000) { await new Promise(r => setTimeout(r, 400)); continue; }
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Failed to reach Anthropic: " + fetchErr.message })
      };
    }
    responseText = await anthropicResp.text();
    const busy = anthropicResp.status === 529 || anthropicResp.status === 500 || anthropicResp.status === 503;
    if (busy && attempt === 0 && Date.now() - _t0 < 3000) {
      console.error(`[retry] feature=${featureId} status=${anthropicResp.status}`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    break;
  }

  if (!anthropicResp.ok) {
    return {
      statusCode: anthropicResp.status,
      headers: corsHeaders,
      body: responseText
    };
  }

  // ── Pull real token counts out of the Anthropic response ──
  // These are the actual billed numbers, not estimates from max_tokens.
  let inTok = 0, outTok = 0;
  try {
    const parsed = JSON.parse(responseText);
    inTok  = parsed?.usage?.input_tokens  || 0;
    outTok = parsed?.usage?.output_tokens || 0;
  } catch { /* non-JSON body — leave at 0 */ }

  // Log every call so the numbers are visible in the Netlify function log
  // even if the blob store is unavailable.
  console.log(`[tokens] feature=${featureId} in=${inTok} out=${outTok} model=${model || "claude-sonnet-4-6"}`);

  // ── Increment usage counters (fire-and-forget, don't block response) ──
  if (store) {
    const dk = dayKey(token, featureId);
    const mk = monthKey(token);
    Promise.all([
      store.set(dk, String(dayUsage + 1)),
      store.set(mk, String(monthUsage + 1)),
      // Token accounting: per-user, site-wide, and per-feature.
      addTokens(store, tokKey(token),              inTok, outTok),
      addTokens(store, tokKeyGlobal(),             inTok, outTok),
      addTokens(store, tokKeyFeature(featureId),   inTok, outTok)
    ]).catch(err => console.error("Usage increment failed:", err.message));
  }

  // ── Return response with usage headers ──
  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      "content-type":    "application/json",
      "X-Client-Token":  token,
      "X-Usage-Day":     String(dayUsage + 1),
      "X-Usage-Month":   String(monthUsage + 1),
      "X-Limit-Day":     String(dailyLimit),
      "X-Limit-Month":   String(MONTHLY_LIMIT),
      "X-Tier":          tier
    },
    body: responseText
  };
};
