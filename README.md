# 🏏 Cricket Auction — Live Polling (Vercel edition)

A complete live polling website for your office cricket auction, built to run **free on Vercel** with a **free Neon Postgres database**.

- **No QR codes.** You share one link (`https://your-app.vercel.app`) in WhatsApp/email and everyone opens it on their phone.
- **No office Wi-Fi needed.** Employees can be on 4G/5G, home Wi-Fi, anything — it's a public HTTPS site.
- **Admin sets any countdown**: 10s, 15s, 20s, 30s, 45s, 1 min, custom seconds… and can restart or extend it **while the poll is live**.
- **One button runs the auction.** Paste the player list once; after that every round is a single press of **SHOUT** — you never type a player name during the bidding (see §4a).

> This is a separate project from your auction website (own deployment, own database, own config).
> The earlier localStorage/SQLite/LAN build is still in the workspace as `cricket-polling/`, but **use this folder** for Vercel.

---

## What this app does (v3.2.1 — auction list + SHOUT)

An office-cricket-auction companion for the audience's phones.

- **You paste the auction list once.** Every player you are selling goes into **Auction list**, in
  bidding order. Names can include a role and a base price (`Rohit Sharma, Batter, 2 Cr`).
- **Then you only press SHOUT.** One big button shouts the next player in that list onto the block:
  every phone instantly announces *"ON THE BLOCK — `<player>`"* and shows the **price slider** from
  20 L to 30.00 Cr on the auction's own ladder. One guess per person per player.
  **You never type a player name during the auction.**
- **Instant everywhere.** A push stream (SSE) delivers the round, the countdown, the guesses and the
  results to every phone and to the projector in ~250 ms. No refresh, no waiting for a poll tick.
- **The admin's answer sheet.** For any round: who guessed what, how far off they were, their rank, and
  everyone who hasn't guessed yet. Enter the sold price → the three closest guesses are declared and
  the player is marked SOLD on the list with their price.
- **There is no multiple-choice polling.** It was removed in v3.0.0 (see §4g).

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

## 4a. 📣 Auction list + the SHOUT button (v3.1.0) — the way you run the auction

This is the whole workflow. Two screens, one button.

### Step 1 — paste the players once (before the auction)

**Auction list** in the sidebar (`/admin/players`). Paste your list, one player per line:

```
Rohit Sharma, Batter, 2 Cr
Jasprit Bumrah, Bowler, 1.5 Cr
Hardik Pandya, All-rounder
Rishabh Pant, Wicketkeeper, 1 Cr
```

- Only the **name** is required. The role and base price are optional; the price is understood as
  lakh (`2 Cr` → 200 L, `80 L` → 80 L, plain `75` → 75 L).
- Duplicates are skipped, so you can re-paste a corrected list without creating doubles.
- `↑ ↓` change the bidding order, click a name to rename, `×` removes, `Clear list` (with a
  confirmation) empties it. Nothing here is typed again on the day.

### Step 2 — press SHOUT for every player

On the **Dashboard**, the top panel is the auction queue:

- **ON THE BLOCK** — the player whose round is open right now, and how many guesses are in.
- **The gold button** — `SHOUT: <next player>`. It always shows the name *before* you press it.
- **SOLD 4 / 12** — how far down the list you are.

Press it once and, in under a second, every phone and the projector announce
**"ON THE BLOCK — `<player>`"** with a full-screen splash, then land on the slider. The round opens
with the countdown from your **Shout settings** card (10s / 15s / 20s / 30s / 45s / 60s / 90s / 2 min,
remembered in your browser; default **10s**).

### Step 3 — enter the sold price

When the hammer falls, type the price in **Enter the sold price**. That closes the round, ranks the
guesses and declares the three closest on every phone and on the projector in ~250 ms. The player is
then marked **SOLD 2.10 Cr** on the list, and the button is already pointing at the next name.

**You cannot skip this.** If a round is live and no price is entered, SHOUT asks you first — because
the three winners of that player would be lost.

### The buttons around the shout panel

| Button | What it does |
| --- | --- |
| `Skip <player>` | Their round closes and they are **not** put on the block; the list moves on. |
| `Mark unsold` | The player is recorded as UNSOLD (no price), and the report keeps that. |
| `Undo shout` | Pulls the player back to the queue and deletes the round (confirm first). |
| `Manage list` | Jumps to the Auction list. |
| `Coming up` | The next five names, so you can see where you are. |

### What the audience sees

- A new player shouted → full-screen **ON THE BLOCK** splash (2 s) with the name, then the slider.
  This also happens on the **confirmation page**, which shows a tappable *"`<player>` is on the block
  — tap to set your price"* banner, so nobody misses a round by staying on their last confirmation.
- A small **⏭ next** pill on the poll screen, and `Next up: <player>` on the projector.

### If you get stuck

- **"Shout did not open a round"** — a round for that same player is still live without a price.
  Enter the price (or `Undo shout`) and press again.
- **"The auction list is empty"** — paste players in `/admin/players` first.
- **Two people with the same name** — the paste appends them both; rename one to tell them apart.

## 4b. ⚡ Round length — "Shout settings"

The auction runs for hours, so the loop is one tap. The **Shout settings** card on the dashboard
(just below the shout panel) picks the countdown that every SHOUT will use:

**10s · 15s · 20s · 30s · 45s · 60s · 90s · 2 min**, remembered in your browser. Out of the box a
shout opens a **10 second** round — the auction pace. Changing it affects the *next* shout; a round
already running keeps its own clock, and `+30s` in the live control panel extends it.

### After a guess, the phone goes back on its own

The **"Guess locked in!"** screen is a confirmation, not a destination. It shows your guess and then
returns to the auction page by itself after ~1.2 s, so nobody is stranded off the slider when the next
player is shouted. There is a `Stay here` button if someone wants to read it first.

Countdowns under a minute show as plain seconds (`15s`, `8s`); longer ones stay `mm:ss`.

## 4b-bis. ⚡ The Lock-in button answers in ~100 ms (v3.2.1)

The complaint: *"when they select bid submit, it takes 3-4 seconds."* Three separate delays were
stacked on top of each other, and none of them were the database.

| Cause | What it cost | Fix |
| --- | --- | --- |
| A deliberate `setTimeout(..., 650)` before navigating | 650 ms, every single tap | removed — the confirmation page *is* the celebration |
| The confirmation page waited for `/api/meta` **then** `/api/state` before painting anything | 2 serverless calls — 1–3 s on a cold function | it paints from the just-submitted result immediately, then refreshes quietly in the background |
| The vote endpoint did 6 database round trips | tens of ms here, more on Neon | 4 now: `INSERT … ON CONFLICT DO NOTHING` (which also removes the duplicate-vote race) plus one statement that bumps the poll and counts the guesses |

Measured on the same test harness that ships with the app (`npm run test:vote-speed`):

| | tap → server answers | tap → "Guess locked in!" on screen |
| --- | --- | --- |
| Before | 69 ms | **786 ms** |
| After, warm | 50 ms | **118 ms** |
| After, with every `/api` call delayed 800 ms (cold function) | 49 ms | **124 ms** |

That last row is the point: on a cold Vercel function the screen no longer waits for the network at
all. The test enforces it — if a future change reintroduces a blocking call on that page, `ui` and
`vote-speed` fail.

The confirmation document itself is also prefetched while the round is open, so the tap has nothing
left to download.

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
| **Auction list (players)** | **`/admin/players`** |
| History & reports | `/admin/history` |
| Full-screen display | `/display` |

---

## 4g. Slider-only rounds (v3.0.0)

Multiple-choice polls have been **removed from the product**. Every round is now a price guess:

> "What will be the bid range for **<player> player**?"

and the audience answers by dragging a slider over the auction ladder (20 L … 30.00 Cr).

What this means in practice:

- The poll editor has **three fields**: player name, optional question text, optional description.
  Leave the question empty and the server writes *"What will be the bid range for `<player>` player?"*.
  There are no answer options anywhere — trying to POST one is rejected.
- `POST /api/vote` accepts only `{pollId, guessLakh}`. A body with `optionId` is refused with
  *"Multiple-choice polls have been removed — pick a price with the slider"*.
- The one-tap **⚡ Next player** card on the dashboard now takes a player name and starts the round.
- Old multiple-choice rows in an existing database still open and still show their old results
  read-only; nothing new can create one.

### The admin's answer sheet (new)

"Who guessed what, and who hasn't guessed yet?" is now a first-class screen, not an export.

Open it from **Polls → 👥 All guesses & winners**, from **History → 👥 All guesses**, or from the
live round's **👥 Guesses** button.

```
GET /api/admin/polls/:id/guesses      (admin session required)

{
  "poll":  { "id": 44, "question": "What will be the bid range for Rohit Sharma player?",
             "playerName": "Rohit Sharma", "status": "closed",
             "actualLakh": 185, "actualLabel": "1.85 Cr", "totalGuesses": 4 },
  "revealed": true,
  "winners": [ { "rank": 1, "name": "Aarav Mehta", "guessLabel": "1.75 Cr",
                 "diffLabel": "10 L", "direction": "under" }, ... ],
  "participants": [
    { "participantId": 7, "name": "Aarav Mehta", "employeeId": "EMP-672905",
      "hasGuessed": true, "guessLabel": "1.75 Cr",
      "diffLakh": 10, "diffLabel": "10 L", "direction": "under",
      "rank": 1, "isWinner": true },
    { "participantId": 9, "name": "Priya Nair", "hasGuessed": false, "rank": null }
  ]
}
```

- **Every participant appears**, guessers first in rank order, then everyone still missing.
- Filter chips: Everyone / Guessed / Not yet — so the host can chase the last few people.
- Type the sold price in the sheet itself (`1.85 Cr`, `185 L`, `1.85` all parse) and the three
  winners are declared on the spot, on every phone and on the projector.
- Export CSV and open the projector from the same sheet.
- The sheet refreshes itself while the round is open, so the "not yet" count drops live.

Scoring is unchanged: closest guess wins, ties go to whoever locked in first, top three are
declared, and a guess that is wildly far away never wins (it is simply ranked last).

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
npm run demo-data             # 20 fake participants + votes + a 10-player auction list
npm run demo-data -- --clean  # remove them
npm run reset -- --yes        # wipe everything and re-seed
```

### Tests (all passing)

```bash
npm run dev                        # terminal 1: http://localhost:4000

npm run test:e2e                   # API + data rules
npm run test:bid                   # slider maths, ranking, winners
npm run test:shout                 # 📣 roster → SHOUT → sold price → next player (browser)
npm run test:ui                    # participant + admin pages (npx playwright install chromium)
npm run test:ui-bid                # the slider round, end to end
npm run test:ui-rapid              # round-length presets (10s/15s/…)
npm run test:ui-session            # admin sign-in, session, logout
npm run test:live                  # push latency + polling fallback
npm run test:routes                # every page + API route on the deployment
npm run test:config                # vercel.json / rewrite / no-socket checks
npm run test:perf                  # perceived load speed
npm run test:vote-speed            # Lock-in latency (cold-function simulation)
```

**Current results (local, v3.2.1), all with zero failures:**

| Suite | Checks | What it proves |
| --- | --- | --- |
| `e2e` | 117 | auth, poll CRUD, join, duplicate + post-deadline blocking, timers, visibility, reset, CSV |
| `bid` | 49 | ladder steps, lakh storage, ranking, three winners |
| **`shout`** | **34** | paste → order → SHOUT → splash on the phone → sold price → SOLD → next SHOUT, plus undo/skip/guards |
| `ui` | 32 | join, dashboard, projector, mobile layouts, auto-return from the confirmation |
| `ui-bid` | 28 | the full slider round on an iPhone 13, incl. the bounce back to the poll |
| **`vote-speed`** | **7** | Lock-in latency, measured warm **and** with every API call delayed 800 ms |
| `ui-rapid` | 18 | 10s…2 min presets, remembered across reloads, used by the next SHOUT |
| `ui-session` | 30 | admin sign-in/session/logout |
| `live` | 10 | start→phone 276 ms, vote→projector 123 ms, price→winners 244 ms, fallback polling |
| `routes` | 17 | `/admin/players` and every other route on a real deployment |
| `config` | 36 | Vercel rewrites, serverless layout, no Socket.IO / QR / local-file DB |
| `perf` | 3 | `/api/state` p95 32 ms, poll screen usable in 78 ms |

Screenshots of the browser runs land in `test/screenshots/` (`sh1-auction-list.png`,
`sh2-shout-splash.png`, `sh3-on-the-block.png`, …).

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
│  ├─ auction.js             the auction list: order, on-the-block, sold/unsold, SHOUT helpers
│  ├─ settings.js            cached event settings
│  ├─ config.js              env defaults (timer + polling cadence)
│  └─ routes/public.js       meta · state · join · vote · results · history
│  └─ routes/admin.js        login · polls · players (/players, /shout) · participants · settings · CSV
├─ public/                   11 HTML pages (incl. admin-players.html), 4 CSS files, 14 JS modules
├─ sql/schema.sql            Postgres schema (idempotent)
├─ scripts/                  seed · reset · demo-data
├─ test/                     e2e · bid · shout · ui · ui-bid · ui-rapid · ui-session · live · routes · perf · config
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

Per the original brief: this is the **audience companion**, not the auction itself. It does not take
bids, does not decide who wins a player, and does not touch your auction website.

The auction list here is only a **queue for shouting players onto the block** — a name, an optional
role and base price, and the price you type when the hammer falls. That is all it stores.

---

*Cricket Auction Live Polling — v3.2.1 · Express + Postgres on Vercel · separate from the auction website.*
