# Ground by KIAN HOW

Know what to say now. Practice what's coming.

A single-file vanilla JS PWA (`index.html`, no build step) with four Netlify Functions. Forked from TM Companion v2.4: the Real-world engine, K's notebook, sync and the AI plumbing came across; the shell, hub, Help me reply, Pitch it and Quick answer are built to the design handoff.

## Files

```
public/index.html           the whole app (CSS, theme bootstrap, JS)
public/manifest.json · public/icons/   PWA
netlify/functions/ai.js     Claude (Sonnet) proxy, DeepSeek for mainland China, per-feature daily limits, owner stats
netlify/functions/codes.js  unlock codes: make (owner), redeem (one device per code)
netlify/functions/transcribe.js  Whisper fallback when the browser's captions caught little
netlify/functions/tts.js    natural voices (OpenAI gpt-4o-mini-tts), the phone's voice is the fallback
netlify/functions/sync.js   encrypted notebook sync (the server only stores bytes)
netlify.toml · package.json
```

## Deploy

1. New GitHub repo, push everything. New Netlify site from the repo (netlify.toml sets the publish directory to `public` and functions to `netlify/functions`; leave the build command empty). Netlify Blobs needs no setup.
2. Environment variables in Netlify:
   - `ANTHROPIC_API_KEY` (required; the name must be exactly this)
   - `OWNER_KEY` (required: a long random string, 30+ characters, not a word or name. Netlify fails the build if any variable value also appears in the code)
   - `DEEPSEEK_API_KEY` (optional: users in mainland China are routed to DeepSeek)
   - `OPENAI_API_KEY` (optional but recommended: realistic voices via `tts.js` and the Whisper transcription fallback; without it the app uses the phone's own voice and captions)
   - `TTS_DAILY_LIMIT` (optional, default 150 spoken lines per device per day) · `TTS_PROVIDER=none` turns the voices off
3. In `netlify/functions/*.js`, the `allowed` origins list has `https://ground.kianhow.com` and `https://groundbykianhow.netlify.app`. Change them to your real site URL (the first entry is the fallback origin).
4. Open the site once with `#owner=YOUR_OWNER_KEY` on each of your own devices. That stores the key locally and turns off limits there. `#owner` opens the codes page; `#owner=off` turns it off again.

## Switches (top of the JS in `index.html`)

```js
const PAYWALL_ON=false;  // free for now. true shows the balance, top-up card and pay flow
const LIVE_ON=false;     // Live mode. true turns on the hands-free call (text-to-speech + auto-listen), no relay yet
const TOPUP={price:'¥39',sessions:30};
const FREE_LIMITS={sessions:40,replies:8}; // per month · per day, only while the paywall is off
```

Server-side limits are in `ai.js` (`DAILY_LIMITS`, `MONTHLY_LIMIT`).

## Codes

- Format `GRD-XXXX-XX`. Made on the owner page (sessions, how many, ends after N days). Stored in Blobs store `ground-codes`.
- A code is bound to the first device that redeems it (the device token in `localStorage['grd-client-token']`). A reinstall gets a new token; the owner can see which device used a code under `dev:<token>` in the store.
- Redeeming adds sessions to `S.credits` on the device. While `PAYWALL_ON` is false, credits are shown but the monthly free limit is what gates practice.

## What's in the AI prompts

Everything K says is built from `K_VOICE`, `K_PLAIN`, `K_JUDGE`, `K_CLIENT_VIEW`, `K_INTERVIEW_VIEW`, `K_PEOPLE_VIEW` (near the top of the JS, section "K's logic"). Change Kian's logic there and every feature follows. The technique library is `TECHNIQUES` in the same section.

Feature ids sent to the server: `reply-draft`, `rw-turn`, `rw-eval`, `pitch-build`, `pitch-notes`, `quick-eval`, `focus-brief`, `nb-note`.

## Working rules

- Surgical edits. `node --check` on the script before shipping (the script is everything between the last `<script>` and `</script>`).
- Test light and dark at 390×844 and 375×667.
- Every user-visible change goes in `CHANGELOG` (What's new).
- No Toastmasters terms anywhere, including prompts. American English. "WeChat" only in the pay flow.
