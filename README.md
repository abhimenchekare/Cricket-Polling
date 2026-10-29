# 🏏 Cricket Auction — Live Polling (Vercel edition)

A complete live polling website for your office cricket auction, built to run **free on Vercel** with a **free Neon Postgres database**.

- **No QR codes.** You share one link (`https://your-app.vercel.app`) in WhatsApp/email and everyone opens it on their phone.
- **No office Wi-Fi needed.** Employees can be on 4G/5G, home Wi-Fi, anything — it's a public HTTPS site.
- **Admin sets any countdown**: 10s, 15s, 20s, 30s, 45s, 1 min, custom seconds… and can restart or extend it **while the poll is live**.

> This is a separate project from your auction website (own deployment, own database, own config).
> The earlier localStorage/SQLite/LAN build is still in the workspace as `cricket-polling/`, but **use this folder** for Vercel.

---

## 1. Why this edition is different (and why it's built this way)

Vercel runs your backend as short-lived serverless functions, which rules out two things the old build relied on:

| Old (LAN edition) | This edition (Vercel) |
| --- | --- |
| Socket.IO WebSockets | **Smart HTTP polling** — every screen refreshes its state every 3s while a poll is live, every 8s when idle, and slows to ~1 request/minute when the tab is in the background. A version fingerprint skips redundant re-renders. |
| SQLite file on disk | **Postgres** (Neon / Vercel Postgres / Supabase) — survives redeploys and works across function instances |
| Background timer loop | **Lazy expiry** — any read or write first closes polls whose countdown has finished, so a 10s poll closes exactly on time even with no server running in between |
| LAN IP + QR code | One public HTTPS link you paste in the team chat |

Everything else is the same feature set: 10 pages, admin panel, one vote per person, per-poll result visibility, anonymous polls, CSV exports, participant management, full-screen presentation mode.

---

## 2. Deploy in ~10 minutes (free)

> 📘 **New to Vercel?** Follow `DEPLOY-STEP-BY-STEP.md` — it walks through every click, including the
> exact answer to "do I need an external database?" (short version: yes, a free hosted Postgres;
> Vercel's own Storage → Neon option creates it from the dashboard and wires `DATABASE_URL` for you).


### Step 1 — Create a free Postgres database (Neon)

1. Go to **https://neon.tech** → sign up (free, no card).
2. Create a project (pick the region closest to you, e.g. `AWS ap-southeast-1` for India).
3. Copy the **connection string** — it looks like:
   ```
   postgresql://neondb_owner:XXXXXXXX@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
   Keep it handy; that's your `DATABASE_URL`.

> Any Postgres works: **Vercel Postgres** (Storage → Create → Postgres), **Supabase**, **Railway**, etc.
> With Vercel Postgres or the Vercel–Neon integration, the variable is injected automatically.

### Step 2 — Put this folder on Vercel

**Option A — GitHub (easiest, survives restarts):**
1. Create a new GitHub repo and upload this folder's contents.
2. Go to **https://vercel.com/new** → *Import* that repo.
3. Framework preset: **Other** (leave build settings empty — this project has no build step).
4. Click **Deploy**.

**Option B — Vercel CLI:**
```bash
npm i -g vercel
cd cricket-polling-vercel
vercel            # first deploy (preview)
vercel --prod     # production deploy
```

### Step 3 — Add environment variables

Vercel → your project → **Settings → Environment Variables** (add to *Production*, *Preview* and *Development*):

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | your Neon string | **Required** |
| `ADMIN_USERNAME` | `admin` | used only when the DB has no admin yet |
| `ADMIN_PASSWORD` | e.g. `cricket@2026#1` | set this to something real, or change it later in the admin panel |
| `ADMIN_DISPLAY_NAME` | `Auction Control Room` | optional |
| `DEFAULT_TIMER_SECONDS` | `30` | default countdown for new polls |
| `NODE_ENV` | `production` | makes cookies `Secure` (required for login over HTTPS) |
| `POLL_INTERVAL_ACTIVE_MS` | `3000` | optional tuning (see §7) |
| `POLL_INTERVAL_IDLE_MS` | `8000` | optional tuning |

Then **Deployments → ⋯ → Redeploy** so the variables take effect.

### Step 4 — Open it

- Join page: `https://your-app.vercel.app`
- Admin: `https://your-app.vercel.app/admin-login`
- Big screen: `https://your-app.vercel.app/display`

Sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`. The database, tables, default admin and 6 sample polls are created automatically on the first request — nothing to run manually.

> **First request is slow (~1–2 s)** while the schema is created and Neon wakes up. Everything after that is fast.

---

## 3. Event-day runbook

1. **Before the event** — sign in, change the password (banner → *Change*), set **Event settings** (name, tagline, big-screen message), and edit/replace the sample polls with tonight's questions.
2. **Share the link** — dashboard → **🔗 Join link** → *Copy link* → paste into your team group. Employees just open it, enter name + employee ID, and they're in. (No QR, no Wi-Fi dependency.)
3. **Project the big screen** — open `/display` in a browser on the projector, press `F` for full-screen. It shows the question, the countdown and live results, plus the join link at the bottom.
4. **Run polls** — pick a poll → **Start**. Every phone switches to it within ~3 seconds. Set 10s/15s/30s from the dashboard row, or restart/extend mid-poll.
5. **Reveal results** — flip **Results visibility → Live** (or just close the poll). Bars animate on every phone and on the projector; a winner reveal + confetti fires on the big screen.
6. **After the event** — History & reports → download CSVs (per poll / all polls / participants).

---

## 4. Timer controls (what you asked for)

**While creating/editing a poll** — presets **10s · 15s · 20s · 30s · 45s · 1m · 1.5m · 2m · 3m · 5m · No limit**, or type any custom number of seconds (0 = no countdown).

**While the poll is live** (dashboard → *Restart countdown* row):
| Control | What it does |
| --- | --- |
| `↻ 10s` … `↻ 2m` | Restarts the countdown from now with that many seconds |
| `+10s` / `+30s` | Adds time to the running countdown |
| `No limit` | Removes the countdown entirely |
| `⏸ Pause` | Stops voting and freezes the remaining time |
| `▶ Resume` | Continues from the frozen time |
| `■ Close` | Ends the poll immediately |

When a countdown reaches zero the poll closes automatically: further votes are rejected by the server (`409 Time is up for this poll`), and the results screen appears on every device.

---

## 4b. ⚡ Rapid round — "who gets bid next?" in 10–15 seconds

The auction runs for hours, so the fastest engagement loop should be one tap:

1. Admin dashboard → **Rapid round** card (above Quick actions).
2. Question + one player per line as options (remembered in your browser, so round 2 is instant).
3. Pick the countdown: **10s / 15s / 20s / 30s / 45s / 60s**.
4. **Create & start round** — created, made live and the clock starts in a single action.

Participants' phones switch to the new question within ~3 s, voting locks the moment the clock hits
zero, and the result appears on every screen (phones + projector) automatically — no second click.
Press the same button again for the next player.

Countdowns under a minute show as plain seconds (`15s`, `8s`); longer ones stay `mm:ss`.

## 4c. Admin panel bouncing to the login page — fixed

The old behaviour: one failed request (database waking up, network blip) answered `401`, the shell
read that as "signed out" and redirected to the login page, dumping whatever you had just clicked.

Now:

- The database layer **retries once** on connection-level errors — Neon suspends idle databases, so
  the first click after a quiet spell can fail, and this absorbs it.
- If identity can't be verified the API answers **503 + retry**, never `401`. A 503 cannot log you out.
- Any stray `401` triggers one silent re-check; only if that also fails does a red **Reconnect**
  banner appear — page, modal and typing stay exactly where they were.
- A genuine expiry lands on the login page with an explanation instead of a blind redirect.

## 4d. 🩺 "Session check" — what to click when the panel logs you out

Dashboard → **🩺 Session check** (Quick actions) shows live values from *your* deployment:

| Line | What it tells you |
| --- | --- |
| Admin cookie present in this browser | `NO` → the browser isn't sending the cookie (wrong URL scheme, embedded preview, cookies blocked) |
| Cookie found in database | `NO` → the cookie belongs to a different database or a session reset — sign in once more |
| Session expires in | Should be ~720 min; sliding expiry refreshes it on every authenticated request |
| DATABASE_URL set / Reachable | `NO` → the server can't reach Postgres (Neon paused, bad connection string) |
| Schema version | Must be `3`; anything else means the tables were only half-created |
| Admin accounts / sessions, Expired sessions in DB | Sanity numbers — expired rows are cleaned up on sight |
| Commit / Environment / Region | Confirms which deployment you are actually looking at |

**Copy report** puts the whole JSON on your clipboard — paste it in the chat and the cause is usually
obvious in one line. The same data is available without logging in at `GET /api/diag`
(cookie presence and booleans only; no secrets).

Common verdicts:

- **Cookie present = NO** → you're on a URL where cookies are dropped: a preview/proxy subdomain, or
  a link that strips cookies. Open the deployment's own `https://…vercel.app` address directly.
- **Cookie present = yes, found in DB = NO** → the deployment points at a different database than the
  one you signed into (e.g. Neon integration added twice, or a Preview vs Production mismatch).
- **Reachable = NO** → Neon suspended/limits reached, or `DATABASE_URL` missing on *this* deployment.

## 4e. 🎯 Bid range rounds — "what will this player sell for?"

This is the auction-specific round type: the host names a player, the room guesses the hammer
price on a **drag bar**, then the host types the sold price and three winners are declared.

### Creating the round

Admin → **Polls → + New poll** → poll type **🎯 Bid range** → enter the **player name**
(the question auto-fills as *"What will be the bid range for &lt;player&gt; player?"*, editable).
No answer options needed; pick a countdown (20 s default) → **Save & start**.

### What participants see

A single **drag bar** across the full price ladder, with a huge live readout, `−` / `+` fine-tune
buttons and quick chips (20 L · 1 Cr · 5 Cr · 10 Cr · 20 Cr · 30 Cr). One guess per participant per
player; the guess is locked for good once submitted.

**The ladder** (81 steps, exactly like the auction board):

| Range | Step |
| --- | --- |
| 20 L, 40 L, 60 L, 80 L | — |
| 1.00 Cr → 9.75 Cr | 0.25 Cr |
| 10.0 Cr → 30.0 Cr | 0.50 Cr |

### Declaring the winners

When the bidding ends, the live card on the dashboard shows **💰 Enter the sold price** with the same
slider. Slide to the hammer price → **Declare winners**.

- The round closes and the results appear on every phone and on the projector instantly.
- **Any** price can be entered, on or off the ladder (a player can sell for 1.10 Cr) — type it via the
  slider or send it straight to the API. Guesses must be on the ladder; the sold price need not be.
- The **three closest guesses** win, ranked 🥇 🥈 🥉. Distance is measured on the ladder, so
  `1.25 Cr` vs a `1.10 Cr` sale is "25 L over".
- **Ties** are broken by who locked their guess in **first** — so there is always a clean 1st/2nd/3rd.
- Each participant sees their own guess, distance, direction and rank (even if they did not win).
- Entered the wrong price? Slide again and **Update price & re-rank** — or **Clear price** to take the
  result back down.

### Reports

History & reports → CSV for a bid round contains the ranked table (rank, winner flag, participant,
guess, difference, direction, timestamp) plus the guess distribution.

### Why guesses are stored in lakh

Every price is an integer number of lakh (`100` = 1.00 Cr), so "closest" is exact integer arithmetic —
no floating-point rounding can ever make two different guesses look equal.

## 5. Pages

| Page | URL |
| --- | --- |
| Participant join | `/` |
| Polling page | `/poll` |
| Vote confirmation | `/vote-confirmed` |
| Results & archive | `/results` |
| Admin login | `/admin-login` |
| Admin dashboard | `/admin` |
| Create & manage polls | `/admin/polls` |
| Participant management | `/admin/participants` |
| History & reports | `/admin/history` |
| Full-screen display | `/display` |

---

## 4f. Instant updates: the live stream (2.4.0)

The host presses **Start** and every phone shows the poll straight away — no refresh, no waiting
for the next poll tick. That is a **Server-Sent Events** stream, not polling.

```
GET /api/stream
event: ready
data: {"serverTime":...,"intervalMs":400}

event: state
data: {"reason":"change","poll":{...},"stats":{...},"history":[...],"version":"..."}
```

How it behaves:

- The audience pages (`/poll`, `/results`, `/display`) open **one** long-lived response.
- The server watches a cheap MD5 fingerprint of everything a viewer can see (poll revisions, vote
  count, participant count, sold prices, settings) on a 300 ms timer — 900 ms when the room has
  been idle for 20 s — and pushes the **full state** the moment it changes, so the client never
  needs a second request.
- The connection is closed on purpose after ~45 s and `EventSource` reconnects automatically.
  `maxDuration` is 60 s, so nothing is ever cut off mid-write.
- If the stream cannot be opened (old browser, corporate proxy, flaky phone network) the page
  **silently falls back to polling** at 1.2 s while a poll is live, 3 s when idle.
- The admin panel polls (1.2 s / 2.5 s) — it is the writer, so push buys it nothing.

Measured on localhost (`npm run test:live`):

| Action | Time until it is on screen |
|---|---|
| admin presses Start → audience phone | **254 ms** |
| admin presses Start → projector screen | **280 ms** |
| a vote → projector count updates | **307 ms** |
| admin closes the poll → results appear | **12 ms** |

Test it yourself against any deployment:

```bash
npm run test:live                                     # local
BASE_URL=https://your-app.vercel.app npm run test:live
```

It checks the stream is actually in use, times all four interactions, and verifies the polling
fallback still works when `/api/stream` is blocked.

**Region matters more than code.** If the measurement on the live site is seconds rather than
milliseconds, open `/api/diag`:

- `config.databaseAwsRegion` — where the Neon database physically sits (e.g. `ap-southeast-1`).
- `config.functionRegion` — where Vercel runs this app (e.g. `iad1`).
- `config.suggestedVercelRegion` — the Vercel region that matches the database.
- `config.regionMatches` — `true` when they already line up.

When `regionMatches` is `false`, pin the function to the database's region in `vercel.json`:

```json
{ "regions": ["sin1"] }
```

(For an audience in India, `bom1` is the low-latency choice **if** the database is in
`ap-south-1`; otherwise match the database — a fast function talking to a far-away database is
still slow.) `perf.stateMs` in `/api/diag` shows how long the state build takes on that
deployment; same-region is typically 5-20 ms, cross-region 200-400 ms.

---

## 5. Speed: why pages felt slow on Vercel (fixed in 2.3.0)

Symptom: the dashboard and the poll screen took 5-15 seconds to appear on the live site, while
localhost was instant.

Cause: the database lives in a different region from the lambda, so **every** SQL round-trip costs
~230 ms. `buildPublicState()` loaded the live poll, then looped over the 12 history polls and ran
~4 queries for each, one after another — about **48 sequential round-trips ≈ 9 s**. The admin
dashboard was worse (one query pair per poll, ~40 round-trips ≈ 15 s).

Fix — the state layer now batches:

| | before | after |
|---|---|---|
| `/api/state` SQL round-trips | ~48 sequential | **4** (1 sweep + 3 in parallel) |
| `/api/admin/state` | ~40 sequential | **5** |
| live `/api/state` latency | 9.1-10 s | ~0.6 s |
| poll screen usable | 9.5 s | < 1 s |
| admin dashboard usable | 15.4 s | ~1.5 s |

How it works (`server/state.js`):

- `LIVE_AND_HISTORY` fetches the live poll, the newest closed poll and the last 12 closed polls in
  **one** query, tagged with a `slot` column.
- `bulkSql()` returns options, vote counts, "my votes" and every bid guess for *all* those polls as
  four JSON arrays in **one** query.
- `indexBulk()` groups those rows in memory; `assemblePoll()` is pure — no queries per poll.

**Rule for future changes: never query inside a loop over polls.** If you add a field to the state
payload, add it to `bulkSql()` (or to the poll select), not to a per-poll function.

Also in 2.3.0: the pg pool keeps TCP connections alive (`keepAlive`, 30 s idle timeout), which
removes a TLS handshake per cold start.

Verify anytime — works against localhost or the live URL:

```bash
npm run test:perf                                    # local
BASE_URL=https://your-app.vercel.app npm run test:perf   # live
```

It prints `/api/state` p50/p95 and the time until the poll screen and dashboard are usable, and
fails if `/api/state` exceeds 2500 ms or a screen exceeds 5000 ms.

---

## 5a. "I deployed but my browser shows the old site"

Since 2.2.1 the app tells you when a newer deployment exists: an in-page banner
**"A newer version (x.y.z) is deployed — Reload"** appears within a minute on any open admin or
participant tab. Nothing reloads by itself (that would be dangerous mid-auction).

Before that, the usual causes are, in order:

1. **The phone/tab has a cached page from the previous deployment.** Hard reload
   (**Ctrl/Cmd + Shift + R**) or open the site in a private tab. On Android Chrome: menu → History →
   Clear browsing data → Cached images and files. On iPhone Safari: Settings → Safari → Clear History
   and Website Data.
2. **You are looking at a different URL.** Production is `https://<project>.vercel.app`. URLs of the
   form `<project>-<hash>-<team>.vercel.app` are *deployment* links and
   `<project>-git-<branch>-<team>.vercel.app` are *preview* links — those can be older, and the git
   ones are SSO-protected.
3. **The deploy never happened.** `curl https://<project>.vercel.app/api/health` — no `build` field
   means old code. See `DEPLOY-STEP-BY-STEP.md`.

Check what your browser *actually* has by opening the dashboard: the sidebar shows
`build 2.2.1 · token-auth`. If that line is missing, your browser is on pre-2.1 code.

## 5b. Is my deployment current?

The current build is **2.1.0**. Verify with any of:

- `GET /api/health` → `"build":"2.1.0+<commit>"` and `"features":{"adminTokenHeader":true,…}`
- `GET /api/diag` → returns JSON (a `404` means the deployment is old)
- Dashboard sidebar → `build 2.1.0 · token-auth`

Assets are requested as `/js/app.js?v=2.1.0`, so a redeploy is never masked by a cached script — but
do one hard refresh (**Ctrl/Cmd + Shift + R**) after deploying.

Full instructions: `DEPLOY-STEP-BY-STEP.md` → *Shipping an update — and proving it actually went live*.

## 5c. Why the admin panel can no longer log you out

Admin sessions now travel **two ways**:

1. the `cp_admin` cookie (normal browsers), and
2. an `x-admin-token` header that the panel keeps in `localStorage` and sends on every admin request.

If a proxy, webview, privacy mode or corporate device drops the cookie, the header still authorises
the request — and the server re-issues the cookie for subsequent page loads. Combined with the
retry-on-transient-error layer and the *Reconnect* banner, a working session can no longer be turned
into a surprise logout by one flaky request.

## 6. Local development & tests

```bash
# 1. Postgres locally (or paste a Neon URL into .env)
#    docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16

cp .env.example .env          # then edit DATABASE_URL
npm install
npm run dev                   # http://localhost:4000

npm run seed                  # show what's in the DB
npm run demo-data             # 20 fake participants + votes (DEMO-xx)
npm run demo-data -- --clean  # remove them
npm run reset -- --yes        # wipe everything and re-seed
```

### Tests (all passing)

```bash
npm run dev                                  # terminal 1
node test/e2e.js                             # 74 API/data checks
node test/ui.js                              # 23 browser checks (npx playwright install chromium)
node test/serverless-sim.js 4030 &           # simulate Vercel: only /api/* reaches the function
BASE_URL=http://localhost:4030 SKIP_PAGES=1 node test/e2e.js
node test/check-vercel-config.js             # vercel.json + routes + no socket/QR leftovers
```

**Results:** 74/74 API · 23/23 browser (iPhone 13 + desktop, zero console errors) · 74/74 **through the serverless simulator** · 29/29 Vercel config checks · data persists across restarts and redeploys (Postgres).

Covered: all pages, admin auth, poll CRUD, join/validation, **duplicate vote → 409**, vote before start, vote while paused, **vote after the deadline → 409**, **timer auto-close**, **10s/15s/restart/extend/no-limit timers**, all three result-visibility modes, single shared active poll, reset with confirmation, blocking a participant, CSV exports, settings propagation, per-viewer payload isolation, and persistence.

Screenshots of the browser run: `test/screenshots/`.

---

## 7. Staying comfortably inside free tiers

Each phone does about **1 request every 3 seconds** while a poll is live (~20 requests/second with 60 people voting at once). Vercel's Hobby plan allows far more than an evening of polling, and the 10-second polls you're planning keep the load tiny.

If you want to be extra conservative, add env vars:

| Variable | Default | Effect |
| --- | --- | --- |
| `POLL_INTERVAL_ACTIVE_MS` | `3000` | Refresh rate while a poll is live (3000–5000 is plenty) |
| `POLL_INTERVAL_IDLE_MS` | `8000` | Refresh rate when nothing is running |

Also:
- Backgrounded tabs automatically drop to ~1 request/minute.
- `GET /api/state` is `no-store` and does a handful of indexed queries — no expensive work per request.
- Free Neon autosuspends when idle and wakes on the next request (~300 ms).
- Clean up after the event with `npm run reset -- --yes` if you reuse the project.

> Note: Vercel's **Hobby** plan is intended for personal/non-commercial projects — a one-off internal office event is fine, but check your company's policy if it's officially sponsored.

---

## 8. Project structure

```
cricket-polling-vercel/
├─ api/index.js              ← Vercel serverless entry (exports the Express app)
├─ server/
│  ├─ app.js                 Express app: /api routes (+ static files for local dev)
│  ├─ db.js                  pg pool, schema bootstrap, first-run seed
│  ├─ auth.js                bcrypt admin login, cookie sessions, guards
│  ├─ state.js               poll snapshots, lazy timer expiry, visibility rules
│  ├─ settings.js            cached event settings
│  ├─ config.js              env defaults (timer + polling cadence)
│  └─ routes/public.js       meta · state · join · vote · results · history
│  └─ routes/admin.js        login · polls + lifecycle · timer · participants · settings · CSV
├─ public/                   10 HTML pages, 4 CSS files, 12 JS modules
├─ sql/schema.sql            Postgres schema (idempotent)
├─ scripts/                  seed · reset · demo-data
├─ test/                     e2e.js · ui.js · serverless-sim.js · check-vercel-config.js
├─ vercel.json               function config, clean URLs, rewrites, no-store headers
├─ .env.example
└─ package.json
```

---

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Database not ready. Check DATABASE_URL` | Variable missing/wrong on Vercel → Settings → Environment Variables → **Redeploy**. `/api/health` shows `hasDatabase`. |
| Login says "Invalid username or password" | Admin was created with `ADMIN_USERNAME`/`ADMIN_PASSWORD` **on first run**. Change env vars and run `npm run reset -- --yes` against that DB, or reset the password in the panel if you can still log in. |
| Login works but you get logged out immediately | `NODE_ENV=production` must be set so cookies are `Secure` on HTTPS (and you must visit the `https://` URL, not a plain-http alias). |
| First page load is slow | Cold start: creating the schema + Neon waking up. Subsequent requests are fast. |
| A poll won't close on time | Check the poll is **active** and that the timer is not `No limit`; the countdown shown is authoritative and closes on the next request after `ends_at`. |
| Results hidden on phones | Per-poll **Results visibility**: `Private` never shows; `After close` only after closing. |
| Someone voted for the wrong option | Admin → dashboard → `⟲ Reset votes` (clears the poll, confirmation required) or Participants → `⟲` to clear one person's votes. |
| Need to start over | `npm run reset -- --yes` (uses `.env`'s `DATABASE_URL`; on Vercel run it locally pointing at the same database). |

---

## 10. What's intentionally not included

Per the original brief: no player prediction scoring, no player selection, no auction bidding/management, no automatic player reveals, no prediction accuracy scoring. Polling only.

---

*Cricket Auction Live Polling — v2.0.0 · Express + Postgres on Vercel · separate from the auction website.*
