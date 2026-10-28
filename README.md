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
