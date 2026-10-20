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

const DAILY_LIMITS = {
  "reply-draft": 10,
  "rw-turn":     80,
  "rw-eval":     20,
  "pitch-build": 12,
  "pitch-notes": 12,
  "quick-eval":  15,
  "focus-brief": 2,
  "nb-note":     6,
  "desk-route":  30,
  "desk-advice": 15,
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
    "https://ground.kianhow.com",
    "https://groundbykianhow.netlify.app",
    "http://localhost:8888",
    "http://localhost:3000"
  ];
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, X-Feature-Id, X-Owner-Key, X-Grace",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Client-Token, X-Usage-Day, X-Usage-Month"
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

    if (!_isOwner && monthUsage >= MONTHLY_LIMIT + grace) {
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

  // ── Geo-routing: China users → DeepSeek ──
  const country = (event.headers["x-nf-geo-country"] || "").toUpperCase();
  const dsKey = process.env.DEEPSEEK_API_KEY;

  if (country === "CN" && dsKey) {
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

  let anthropicResp;
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
        max_tokens: max_tokens || 1024,
        system:     system     || "",
        messages
      })
    });
  } catch (fetchErr) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to reach Anthropic: " + fetchErr.message })
    };
  }

  const responseText = await anthropicResp.text();

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
      "X-Limit-Month":   String(MONTHLY_LIMIT)
    },
    body: responseText
  };
};
