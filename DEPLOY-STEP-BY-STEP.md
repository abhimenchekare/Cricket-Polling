# Deploy to Vercel — step by step

Follow this top to bottom. Nothing here costs money; every step uses a free tier.

**Time needed:** ~10 minutes.

---

## First: do you need an external database?

**Yes — you need a hosted Postgres database. It cannot be avoided on Vercel.**

Why:

| Reason | Detail |
| --- | --- |
| Vercel's filesystem is read-only | Code can be uploaded, but a file like `polling.db` cannot be written at runtime. SQLite is impossible. |
| Every request may hit a different instance | Polls/votes must live somewhere all instances can see. |
| Deployments are immutable | Each deploy gets a fresh container. A file written now is gone on the next deploy. |

So the database lives **outside** Vercel, and the app connects to it over the network with a connection string (`DATABASE_URL`).

That said, this is still "hosted on Vercel, for free":

- **Neon** free plan: 1 GB storage, permanently free, no credit card.
- **Vercel Marketplace → Neon**: creates the database *from inside the Vercel dashboard* and injects `DATABASE_URL` into your project automatically. It is Neon under the hood.
- **Supabase** free plan also works (any Postgres does).

Pick whichever you prefer. If you have no preference, use **Path A** below (Marketplace) — it is the fewest clicks.

> If you ever *must* avoid any external service, the only alternative is a host that gives you a persistent disk (Railway, Fly.io, Render, or a local PC) — not Vercel. Ask and I can prepare that variant.

---

## Step 1 — Get the code somewhere Vercel can read

You need one of: a GitHub repo, or the Vercel CLI.

### Option 1A — GitHub (recommended, easiest to update later)

1. Unzip `cricket-polling-vercel.zip`.
2. In GitHub click **New repository** → name it e.g. `cricket-polling` → **Private** → *Create repository*.
3. On the empty repo page click **uploading an existing file**.
4. Drag in **everything inside the `cricket-polling-vercel` folder** — including the hidden `.env.example`, `.gitignore` and the `api/` folder.
   Do **not** upload `node_modules` or a `.env` file (they must stay out of Git; `.gitignore` already handles this).
5. Commit.

### Option 1B — Vercel CLI (no GitHub)

```bash
npm i -g vercel
cd cricket-polling-vercel
vercel login
```

---

## Step 2 — Create the database and link it

### Path A — Vercel Marketplace (recommended)

Do this **after** the first deploy (Step 3), because the Marketplace connects a database to an existing Vercel project:

1. In the Vercel dashboard open your project → **Storage** tab.
2. Click **Create Database** → choose **Neon** (Postgres) → **Continue**.
3. Free plan → choose the region closest to you (e.g. **AWS ap-southeast-1 / Singapore** for India) → **Create**.
4. When asked, **Connect** the database to your project and tick **Production**, **Preview** and **Development**.
5. Done — Vercel injects `DATABASE_URL` (plus `PGHOST`, `PGUSER`, …) into your project. You do **not** copy anything by hand.

### Path B — Neon directly (manual)

1. Go to **https://neon.tech** → sign up (Google/GitHub, no card).
2. **Create project** → pick the nearest region → create.
3. In the project, click **Connect** (top nav) → select branch `main`, database `neondb`, role `neondb_owner` → **copy the connection string**. It looks like:
   ```
   postgresql://neondb_owner:AbC123xyz@ep-cool-name-123456-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
   > Keep the `-pooler` host if present — pooled connections are what serverless functions need.
4. Keep this string for Step 4.

---

## Step 3 — Deploy the project

### Option 3A — GitHub

1. Go to **https://vercel.com/new** → sign up with GitHub if needed.
2. **Import** your `cricket-polling` repo.
3. On the configure screen:
   - **Framework Preset:** `Other`
   - **Build Command:** leave empty / override as empty
   - **Output Directory:** leave empty
   - **Install Command:** leave default (`npm install`)
   - **Root Directory:** `.` (the folder that contains `package.json`)
4. Click **Deploy**. It finishes in well under a minute (there is no build step — the pages are static and `api/index.js` is the backend function).

### Option 3B — CLI

```bash
cd cricket-polling-vercel
vercel            # answer the prompts, accept the defaults, creates a Preview deployment
vercel --prod     # promote to production
```

---

## Step 4 — Add environment variables

Vercel dashboard → your project → **Settings → Environment Variables**.

| Name | Value | Environments | Required? |
| --- | --- | --- | --- |
| `DATABASE_URL` | your Postgres string | Production, Preview, Development | **Yes** — skipped entirely if you used Path A, the integration already set it |
| `ADMIN_USERNAME` | `admin` | All | Yes (first run) |
| `ADMIN_PASSWORD` | something real, e.g. `Cricket#2026` | All | Yes (first run) |
| `ADMIN_DISPLAY_NAME` | `Auction Control Room` | All | Optional |
| `DEFAULT_TIMER_SECONDS` | `30` | All | Optional |
| `NODE_ENV` | `production` | Production | **Yes** — makes the login cookie `Secure` on HTTPS |
| `POLL_INTERVAL_ACTIVE_MS` | `3000` | All | Optional (refresh speed while a poll is live) |
| `POLL_INTERVAL_IDLE_MS` | `8000` | All | Optional |

Notes:
- **`ADMIN_USERNAME` / `ADMIN_PASSWORD` only matter on the very first run**, when the admin account is created. If you change them later the existing account is untouched (change the password inside the admin panel instead).
- Use **Secret** type for `DATABASE_URL` and `ADMIN_PASSWORD` if you want them hidden after saving.

---

## Step 5 — Redeploy (this step is mandatory)

Vercel bakes environment variables into each deployment; the running one will **not** see newly added variables.

**Deployments** tab → the newest deployment → **⋯** → **Redeploy** → confirm.
(If you used Path B, this is the deploy that finally has `DATABASE_URL`.)

---

## Step 6 — Verify it works

1. Open `https://<your-project>.vercel.app/api/health`
   You should see:
   ```json
   {"ok":true,"service":"cricket-polling","platform":"vercel","hasDatabase":true,"serverTime":...}
   ```
   - `hasDatabase: false` → `DATABASE_URL` is missing on this deployment → redo Step 4 and **redeploy**.
2. Open `https://<your-project>.vercel.app/` → the join page should render with a share link.
   (The very first request is slow for 1–2 s: tables are being created and Neon is waking up. Normal.)
3. Open `https://<your-project>.vercel.app/admin-login` → sign in with the admin credentials from Step 4.
4. Dashboard should show 6 sample polls in the **Queue**.

✅ If those four work, the deployment is complete.

---

## Step 7 — First 5 minutes in the admin panel

1. **Change the password** — a yellow banner appears until you do (*Change* → new password → save). The session stays valid on this device.
2. **⚙️ Event settings** → event name, tagline, big-screen message → **Save**.
3. **Polls** → open each sample poll → **✏️ Edit** → replace with your real questions, pick a timer (10s / 15s / 30s / custom) and result visibility → *Save as draft*.
4. Delete any sample polls you do not need.

---

## Step 8 — Share with the team (no QR, no office Wi-Fi)

1. Dashboard → **🔗 Join link** → **Copy link**.
2. Paste it in the team WhatsApp/Teams/email group. It will look like
   `https://cricket-polling.vercel.app` (you can also add a custom domain, see below).
3. Employees open it on any network (mobile data is fine) → name + employee ID → vote.

Optional: **Settings → Domains → Add** to use something like `polls.yourcompany.com` (needs DNS access).

---

## Step 9 — On the day

1. Projector/laptop: open `/display`, press **F** for full-screen.
2. Create or select a poll → **▶ Start** (every phone switches within ~3 s).
3. Live timer row on the dashboard: `↻ 10s`, `↻ 15s`, `↻ 30s`, `+10s`, `+30s`, `No limit`, `⏸ Pause`, `■ Close`.
4. Reveal results: switch **Results visibility → Live**, or just close the poll.
5. After the event: **History & reports** → download CSVs.

---

## Build failed: "Error: No entrypoint found. Searched for: app (.ts…), index, server, src/app, src/index, src/server, main, src/main"

**What it means.** Vercel installed your dependencies (87 packages — correct) and then decided the
project is a **Node.js server app**, so it went looking for a root entrypoint (`index.js`, `server.js`,
`app.js`, `src/index.js`, …). There is no such file — our backend lives in `api/index.js` and the
frontend is plain static files in `public/`. Vercel never even reached our code.

**The fix (already applied in this build).** Tell Vercel explicitly that this is a static build
pointing at `public/`, which switches off the Node-entrypoint guessing:

- `vercel.json` → `"buildCommand": "npm run vercel-build"` + `"outputDirectory": "public"`
- `package.json` → `"vercel-build": "node scripts/vercel-build.js"`
- `scripts/vercel-build.js` → validates `public/index.html`, `api/index.js`, all 10 pages, syntax-checks
  the server files, and prints a clear error instead of deploying a broken site.

That build command also makes failures readable: instead of "No entrypoint found" you get
`[vercel-build] BUILD FAILED — Missing folder: public/ …` if the repo layout is off.

### Apply it to your repo (2 minutes)

You only need to update **3 files** — no need to re-upload everything:

| File | Action |
| --- | --- |
| `vercel.json` | replace whole file with the content below |
| `package.json` | add the one line `"vercel-build": "node scripts/vercel-build.js"` to `"scripts"` |
| `scripts/vercel-build.js` | **Add file → Create new file**, path `scripts/vercel-build.js`, paste |

`vercel.json` (full file):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "version": 2,
  "framework": null,
  "buildCommand": "npm run vercel-build",
  "outputDirectory": "public",
  "installCommand": "npm install",
  "functions": {
    "api/index.js": { "memory": 1024, "maxDuration": 30 }
  },
  "cleanUrls": true,
  "trailingSlash": false,
  "rewrites": [
    { "source": "/api", "destination": "/api/index" },
    { "source": "/api/(.*)", "destination": "/api/index" },
    { "source": "/admin/polls", "destination": "/admin-polls.html" },
    { "source": "/admin/participants", "destination": "/admin-participants.html" },
    { "source": "/admin/history", "destination": "/admin-history.html" }
  ],
  "headers": [
    { "source": "/api/(.*)", "headers": [{ "key": "Cache-Control", "value": "no-store, max-age=0" }] },
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "SAMEORIGIN" },
        { "key": "Referrer-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

Then commit → Vercel rebuilds automatically (or use the **Redeploy** button on the failed deployment).

> Easiest alternative: download the updated ZIP from the chat, delete the old files in GitHub and
> upload the new ones. Either way, make sure `vercel.json` at the repo root contains
> `"buildCommand"` — that single key is what fixes this error.

### If it *still* says "No entrypoint found"

Your Vercel project has `Framework Preset = Node.js` or a leftover **Build Command** override:

1. **Settings → Build & Development Settings**
   - Framework Preset → **Other**
   - Build Command → **clear the override** (leave "Use project setting" / default)
   - Output Directory → **clear the override** (leave "Use project setting")
   - Install Command → default
2. **Settings → General → Root Directory** → empty (unless the files really are in a sub-folder).
3. Redeploy. Settings overrides beat `vercel.json`, which is the usual reason a config change appears to do nothing.

### Nuclear option (bypasses all detection)

Deploy straight from your machine — the CLI uploads the files as they are on disk:

```bash
npm i -g vercel
cd cricket-polling-vercel      # folder that contains vercel.json + api/ + public/
vercel login
vercel --prod
```

---

## "No Production Deployment" — nothing is deploying

This is the state in your screenshot: the project exists, Git is connected (checklist ✓),
but Vercel has **not built anything yet**. Vercel only builds when a commit lands on the
production branch (`main`) or when you deploy manually — connecting the repo alone does nothing.

### A. First check the repo layout (the #1 cause)

Open your repo on GitHub. At the **top level of the repo** you must see exactly these:

```
api/           public/        server/        scripts/      sql/       test/
package.json   vercel.json    README.md      .env.example  .gitignore
```

If instead you see a single folder (e.g. `cricket-polling-vercel/`) and the files are inside
that, Vercel cannot find `package.json` or `public/`, so the build produces nothing.

**Fix — pick one:**
- *Preferred:* move everything to the repo root (GitHub → open the folder → edit each file is painful; easier to re-upload: delete the folder in GitHub and use **Add file → Upload files**, dragging the folder's **contents**, not the folder), **or**
- Vercel → **Settings → General → Root Directory** → set it to `cricket-polling-vercel` → **Save**, then redeploy.

> `.gitignore` can hide `.env` etc. from uploads — that is correct and expected.

### B. Trigger the first deployment (3 ways)

1. **Push a commit to `main`** (simplest): on GitHub open `README.md` → pencil ✏️ → add a blank line → **Commit changes** → *Commit to main*.
   Vercel builds within seconds.
2. **From Vercel:** project → **Deployments** tab → if you see any entry, **⋯ → Redeploy**;
   if the list is empty, click **Create New → Project → Import** the same repo again (this time press **Deploy** on the configure screen — the project page you are looking at was created without that final click).
3. **Via CLI** (skips GitHub entirely):
   ```bash
   npm i -g vercel
   cd cricket-polling-vercel
   vercel --prod
   ```

### C. When a deployment does appear, sanity-check the result

- **Deployment status = Ready**, and the Overview shows a green *Production Deployment* card with a domain.
- Open `https://<project>.vercel.app/api/health` → must return `{"ok":true,...,"hasDatabase":true}`.
  - `hasDatabase:false` → `DATABASE_URL` is not on this deployment → see next section.
- Open `https://<project>.vercel.app/` → the join page appears.
  - **404 here** → the static pages weren't picked up. Confirm `vercel.json` contains
    `"outputDirectory": "public"` (this build already does) and that `public/index.html` exists at the
    repo path Vercel is building (check *Root Directory*).

### D. Neon was added — is it actually wired to this project?

Adding a database in **Storage** does not always connect it to the project automatically:

1. Vercel → **Storage** → click your Neon database → **Connect Project** → select `cricket-polling`
   → tick **Production**, **Preview**, **Development** → **Connect**.
2. **Settings → Environment Variables** → you should now see `DATABASE_URL` (and `PGHOST` etc.)
   marked as integration-managed.
3. Set `NODE_ENV=production` and your own `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
4. **Deployments → ⋯ → Redeploy.** Variables are baked per deployment; the first build without
   `DATABASE_URL` will keep failing until you redeploy.

### E. If the build itself fails, read the log

Project → **Deployments** → click the failed deployment → **Build Logs**. The usual messages:

| Log line | Meaning / fix |
| --- | --- |
| `No Output Directory named "public" found` | `public/` is not where Vercel is building → check Root Directory / repo layout (section A) |
| `npm install` error, `ENOENT package.json` | Files are nested one level too deep → section A |
| Build succeeds but the site is 404 | Root Directory mismatch, or you opened a Preview URL with no branch build yet |
| `Function api/index.js ... module not found` | `pg`/`express` missing from `package.json` dependencies → re-upload `package.json` and `package-lock.json` |

---

## Troubleshooting (most common issues first)

| What you see | Cause & fix |
| --- | --- |
| `Database not ready. Check DATABASE_URL on the server.` | Variable missing/wrong on the **live** deployment. Add it in Settings → Environment Variables, then **Redeploy**. Check `/api/health` shows `hasDatabase: true`. |
| `Invalid username or password` on first login | The admin was created with different credentials. Either use exactly what `ADMIN_USERNAME`/`ADMIN_PASSWORD` were at first run, or reset the DB (see below). |
| Login succeeds, then you're logged out on the next click | `NODE_ENV=production` is missing (cookie not `Secure`), or you opened the deployment over plain HTTP. Always use the `https://` URL and set `NODE_ENV=production`, then redeploy. |
| `20 Unknown database 'neondb'` / auth errors | The connection string was truncated when pasted (Neon strings are long) or the password contains characters that were URL-encoded wrong. Re-copy the full string from **Connect**. |
| First page load takes 2–3 s, later loads are instant | Neon free tier auto-suspends when idle; the first request wakes it. Harmless. Keep a phone or the projector on the page to keep it warm during the event. |
| Everything loads but voting fails with 500 | Usually the schema never finished creating (first request timed out). Open `/api/health`, then reload `/api/meta` once; or redeploy. |
| Poll never closes by itself | Check the poll is **active** and the timer is not `No limit`. Expiry is evaluated on the next request from any client, which happens every ~3 s while the poll is live. |
| Results don't show on phones | Per-poll visibility: `Private` never shows; `After close` only after closing; use `Live during`. |
| Need to start over completely | Locally: `cp .env.example .env`, put the same `DATABASE_URL` in it, `npm install`, then `npm run reset -- --yes`. Or in Neon: delete the project and create a new one, then update `DATABASE_URL` and redeploy. |

### Useful commands (local, with the same database)

```bash
npm install
# put DATABASE_URL into .env first
npm run seed                       # show what is in the database
npm run demo-data                  # 20 fake participants + votes for a rehearsal
npm run demo-data -- --clean       # remove them
npm run reset -- --yes             # wipe polls/votes/participants, re-seed samples
npm run dev                        # run locally at http://localhost:4000
```

---

## Free-tier reality check

- **Vercel Hobby:** this app makes one small JSON request per phone every ~3 s while a poll is live (tabs in the background drop to ~1 request/minute). An evening of polling with 50–100 phones is far inside the free allowance.
- **Neon Free:** 1 GB storage and a monthly compute allowance — a single evening uses a tiny fraction (the whole database is a few hundred KB).
- Turn the site off afterwards by deleting the Vercel project, or keep it for the next event and just run `npm run reset -- --yes`.
- Vercel's Hobby plan is aimed at personal/non-commercial use; a one-off internal office event is fine, but check with your company if it's officially sponsored.

---

## Quick reference

| Thing | Where |
| --- | --- |
| Join page | `https://<project>.vercel.app/` |
| Admin login | `https://<project>.vercel.app/admin-login` |
| Big screen | `https://<project>.vercel.app/display` |
| Health check | `https://<project>.vercel.app/api/health` |
| Env vars | Project → Settings → Environment Variables → **then Redeploy** |
| Database | Vercel → Storage (Path A) or neon.tech console (Path B) |
| Logs | Project → Deployments → click a deployment → **Functions / Runtime Logs** |
