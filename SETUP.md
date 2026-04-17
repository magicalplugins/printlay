# P1 setup checklist

The code is scaffolded. Five things still need a human (you) because they require dashboard logins or your own credentials. Do them in this order.

> **CRITICAL — Isolation requirement.** The Fly.io account `info@magicalplugins.com` already has live paying-customer apps on it:
> - `tradeprint-shopify` (LIVE — paying customers)
> - `murphys-magic-connector` (LIVE)
> - `fly-builder-misty-waterfall-1392` (internal builder, ignore)
>
> The new `printlay` app must be completely isolated from those. Two rules make that safe:
> 1. **Always pass `-a printlay`** on every `fly` command in this doc. Never run a `fly` command without it.
> 2. **Do not use `fly launch`** for this project — it's interactive and can pick up the wrong defaults. Use `fly apps create` then `fly deploy` instead.

---

## 0. Authenticate to Fly (one time per machine)

```bash
fly auth login                # opens a browser, sign in as info@magicalplugins.com
fly auth whoami               # must print: info@magicalplugins.com
fly apps list                 # confirm the existing live apps are visible
```

If `whoami` shows a different account, **stop** — fix the auth before proceeding.

---

## 1. Initialise git and push to GitHub

```bash
cd /Users/anthonymagic/Sites/PrintLay
git init
git add .
git commit -m "P1: project skeleton (FastAPI + Vite + Tailwind + GH Actions)"
```

Then create the repo on GitHub (UI: https://github.com/new — name it `printlay`, private), and:

```bash
git remote add origin git@github.com:<YOUR_GITHUB_USERNAME>/printlay.git
git branch -M main
git push -u origin main
```

---

## 2. Cloudflare R2 — bucket + token

1. Sign in at https://dash.cloudflare.com → R2.
2. Create bucket: name it `printlay-files` (location: Automatic).
3. Manage R2 API Tokens → "Create API Token":
   - Permissions: **Object Read & Write**
   - Specify bucket: `printlay-files`
   - TTL: leave blank (no expiry)
4. Copy these four values somewhere safe:
   - Access Key ID
   - Secret Access Key
   - Endpoint (looks like `https://<account-id>.r2.cloudflarestorage.com`)
   - Bucket name (`printlay-files`)

---

## 3. Supabase — project + keys

1. Sign in at https://supabase.com → New project.
   - Name: `printlay`
   - Region: closest to you / your users (London if UK-focused).
   - Password: generate strong, save in your password manager.
2. Once provisioned, open Project Settings:
   - **API** tab → copy:
     - Project URL (`https://<id>.supabase.co`)
     - `anon` key
     - `service_role` key
     - JWT Secret (under JWT Settings)
   - **Database** tab → copy the **Transaction pooler** connection string (port 6543).
3. **Authentication → Providers**:
   - Enable Email (default).
   - Enable Google OAuth (you'll need a Google Cloud OAuth client; can do later in P2).

---

## 4. Fly.io — create the app, set secrets, deploy

> Every command below has `-a printlay`. Do not omit it.

### 4a. Create the app (does NOT deploy)

```bash
cd /Users/anthonymagic/Sites/PrintLay
fly apps create printlay
```

If `printlay` is already taken globally, pick another name (e.g. `printlay-app`), update `app = "printlay"` in `fly.toml` to match, and use the new name in every subsequent command.

**Verify** the new app exists alongside (not instead of) the live apps:

```bash
fly apps list
# You should still see tradeprint-shopify, murphys-magic-connector, AND now printlay.
```

### 4b. Set all secrets in one shot

```bash
fly secrets set \
  ENVIRONMENT=production \
  SUPABASE_URL='https://<id>.supabase.co' \
  SUPABASE_ANON_KEY='...' \
  SUPABASE_SERVICE_ROLE_KEY='...' \
  SUPABASE_JWT_SECRET='...' \
  DATABASE_URL='postgresql+psycopg://postgres.<id>:<password>@aws-0-eu-west-2.pooler.supabase.com:6543/postgres' \
  R2_ENDPOINT='https://<account>.r2.cloudflarestorage.com' \
  R2_ACCESS_KEY='...' \
  R2_SECRET_KEY='...' \
  R2_BUCKET='printlay-files' \
  -a printlay
```

(The pooler hostname/port differs by Supabase region — paste exactly what Supabase shows you under Database → Connection string → Transaction.)

Verify secrets are set (digests only, no values shown):

```bash
fly secrets list -a printlay
```

### 4c. Run the database migrations (first deploy only, then on every schema change)

The schema is managed by Alembic. Run migrations against the Supabase pooler URL from your laptop **before** the first Fly deploy:

```bash
cd /Users/anthonymagic/Sites/PrintLay
source .venv/bin/activate          # see "Local dev" below if you haven't created one
export DATABASE_URL='postgresql+psycopg://postgres.<id>:<password>@aws-0-eu-west-2.pooler.supabase.com:6543/postgres'
alembic upgrade head
```

You should see all four migrations applied (`0001_users`, `0002_templates`, `0003_jobs_assets_outputs`). Verify in the Supabase dashboard → Table Editor that the tables `users`, `templates`, `jobs`, `asset_categories`, `assets`, `outputs` now exist.

For future schema changes, run `alembic revision --autogenerate -m "..."` after editing models, review the generated file, then `alembic upgrade head`.

### 4d. First Fly deploy

```bash
fly deploy -a printlay
```

Watch the build. On success, the app is live at `https://printlay.fly.dev`.

### 4e. Verify

```bash
fly status -a printlay
fly logs -a printlay --no-tail | tail -50
curl https://printlay.fly.dev/api/health
# {"status":"ok","environment":"production"}
```

Open https://printlay.fly.dev in a browser — you should see the placeholder hero with the green health check at the bottom.

### 4f. Isolation check (run after deploy)

```bash
fly apps list                                # all 3 apps still listed
fly status -a tradeprint-shopify             # still 'deployed'
fly status -a murphys-magic-connector        # still 'deployed'
fly status -a printlay                       # 'deployed'
```

If either of the existing apps shows anything other than healthy/deployed, **stop and investigate** — do not push more changes.

---

## 5. GitHub Actions — Fly token

So pushes to `main` auto-deploy.

1. On your laptop:
   ```bash
   fly tokens create deploy --name "github-actions" -a printlay
   ```
   Copy the token string (starts with `FlyV1 fm2_...`).
2. On GitHub → your `printlay` repo → Settings → Secrets and variables → Actions → New repository secret:
   - Name: `FLY_API_TOKEN`
   - Value: (paste the whole token)

From now on, `git push origin main` triggers `.github/workflows/deploy.yml` which runs `fly deploy --remote-only`. The workflow reads the app name from `fly.toml`, so no extra config needed.

---

## Local dev (optional, for after P1)

```bash
# backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in local values (can mirror prod for now)
uvicorn backend.main:app --reload --port 8000

# frontend (separate terminal)
cd frontend
npm install
npm run dev
# open http://localhost:5173 — it proxies /api to :8000
```

---

## Useful Fly commands (always with `-a printlay`)

```bash
fly logs -a printlay                         # live tail
fly logs -a printlay --no-tail | tail -50    # recent
fly apps restart printlay
fly ssh console -a printlay                  # shell into the running machine
fly secrets list -a printlay                 # digests only, never values
fly secrets set KEY=value -a printlay
fly scale memory 1024 -a printlay
fly ips list -a printlay
```

---

## Common mistakes to avoid

1. **Forgetting `-a printlay`** — some Fly defaults can pick up the wrong app on the same account.
2. **Running `fly launch`** — it's interactive and may modify `fly.toml` / create unwanted Postgres. Use `fly apps create` + `fly deploy` instead (this doc).
3. **Touching `tradeprint-shopify` or `murphys-magic-connector`** — they're paying-customer live. Never run any `fly` command against them from this project.
4. **Setting `DATABASE_URL` to the direct (port 5432) Supabase URL** — use the **pooler** URL (port 6543, hostname starts `aws-0-...pooler.supabase.com`). The direct URL exhausts connections fast under load.
5. **Pushing `.env` to git** — `.gitignore` already excludes it. Don't override.

---

## What's already built (sit-rep)

The repo already contains, end-to-end:

- **P1**: FastAPI + Vite skeleton, Dockerfile, `fly.toml`, GitHub Actions auto-deploy.
- **P2**: Supabase JWT verify, `/api/auth/me`, frontend `AuthProvider` + `RequireAuth`, login/register pages.
- **P2.5**: Animated Gen-Z landing page (Hero + 4-step `KineticSteps` + `DemoClip` slot + `SignupBlock`).
- **P3**: Templates table + Alembic migration, PyMuPDF parser (POSITIONS OCG detection), R2 client, upload endpoint, Templates list + detail (PDF.js renderer + slot overlay).
- **P4**: PDF generator (auto-fit grid of rect/circles on POSITIONS OCG), generate endpoint, wizard generate-step with live SVG preview.
- **P5**: Jobs table, JobProgrammer (click-to-number + auto-row-order), CRUD endpoints.
- **P6**: Categories + assets tables, asset upload pipeline (PDF normalisation, JPEG thumbs, raster→PDF, SVG→PDF), Catalogue page.
- **P7**: JobFiller with quantity modal, `POST /api/jobs/{id}/fill` filling next-N empty slots in `slot_order`.
- **P8**: PDF compositor (`page.show_pdf_page` per filled slot, fit-centred, POSITIONS OCG turned OFF in output config — verified locally), Outputs table + `/generate` + presigned download.

**Verified locally** by smoke test: generated A4 template → composited a raster asset into 3 of 6 circles → output PDF preserved 841.9×595.3pt artboard byte-exact, POSITIONS OCG persisted as `on: False` in the round-tripped PDF (renders cleanly without slot rectangles).

## What I need from you to take it live

1. Complete steps 1–5 above (git push, R2, Supabase, Fly secrets, GitHub Actions token).
2. Run `alembic upgrade head` against the Supabase pooler URL (step 4c).
3. `fly deploy -a printlay` (step 4d).
4. Visit `https://printlay.fly.dev`, register an account, then walk:
   - Templates → New template → Generate (e.g. 297×210mm, 55mm circles, 5mm gap) → opens in detail view with overlay.
   - Catalogue → New category → upload a few PNGs/PDFs.
   - Templates → that template → "Program slots →" → click in order or use auto-order rows → Continue.
   - In the filler: click an asset, type a quantity, slots fill. Click "Generate PDF →".
   - Outputs → download the PDF, drop it in VersaWorks → assets land in their exact slot positions, no rectangles visible.

Open items pre-launch:
- **PyMuPDF licensing**. PyMuPDF is AGPL-3.0; using it in a hosted SaaS is generally fine if you're not distributing the binary, but Artifex (the upstream) sells commercial licences if you want to be conservative. Decide before public launch.
- **Email confirmation**. Supabase defaults to requiring email confirmation. If you want to skip it during early testing, Authentication → Providers → Email → toggle "Confirm email" off.
- **Free-tier rate limiting**. No per-user rate limit on `/jobs/{id}/generate` yet — fine for v1, worth adding once subscriber count grows.

