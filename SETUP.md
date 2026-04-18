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

## 1. Push to GitHub

The repo is already initialised and the v1 build (P1–P9) has been committed
on `main` locally. Just create the remote and push:

Create the repo on GitHub (UI: https://github.com/new — name it `printlay`, private), then:

```bash
cd /Users/anthonymagic/Sites/PrintLay
git remote add origin git@github.com:<YOUR_GITHUB_USERNAME>/printlay.git
git push -u origin main
```

---

## 2. Object storage — Fly Tigris

We use Fly's native S3-compatible storage (Tigris). It has zero egress fees,
lives in the same edge as the app, and one CLI command provisions everything.

You don't do this step now — it's done in step 4 below, after the Fly app is
created, with a single command (`fly storage create`). Skip ahead to step 3.

> The code is vendor-neutral S3 (boto3). If you ever want to swap to Cloudflare
> R2, AWS S3, MinIO, etc., just override the `STORAGE_*` secrets — no code change.

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

### 4b. Provision Tigris storage (one command, auto-injects secrets)

```bash
fly storage create -a printlay
```

When prompted:
- Bucket name: `printlay-files` (or accept the auto-generated one)
- Public/Private: **Private** (we serve via presigned URLs)

This creates an S3-compatible bucket and **automatically sets these secrets on
the `printlay` app**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BUCKET_NAME`. The backend's config layer
picks these up automatically — no manual `fly secrets set` needed for storage.

### 4c. Set the Supabase + app secrets

```bash
fly secrets set \
  ENVIRONMENT=production \
  SUPABASE_URL='https://<id>.supabase.co' \
  SUPABASE_ANON_KEY='sb_publishable_...' \
  SUPABASE_SERVICE_ROLE_KEY='sb_secret_...' \
  DATABASE_URL='postgresql+psycopg://postgres.<id>:<password>@aws-0-eu-west-2.pooler.supabase.com:6543/postgres' \
  -a printlay
```

(The pooler hostname/port differs by Supabase region — paste exactly what Supabase shows you under Database → Connection string → Transaction.)

> **JWT verification.** New Supabase projects sign user tokens with an
> asymmetric key (ES256/RS256) published at
> `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. The backend fetches and
> caches that JWKS automatically — there is **no** `SUPABASE_JWT_SECRET`
> to set. If you ever migrate to (or restore) a legacy HS256 project, set
> `SUPABASE_JWT_SECRET=<hex>` and the verifier will fall back to it for
> tokens missing a `kid` header.

Verify secrets are set (digests only, no values shown):

```bash
fly secrets list -a printlay
# You should see SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
# DATABASE_URL, AWS_*, BUCKET_NAME, ENVIRONMENT.
```

### 4d. Run the database migrations (first deploy only, then on every schema change)

The schema is managed by Alembic. Run migrations against the Supabase pooler URL from your laptop **before** the first Fly deploy:

```bash
cd /Users/anthonymagic/Sites/PrintLay
source .venv/bin/activate          # see "Local dev" below if you haven't created one
export DATABASE_URL='postgresql+psycopg://postgres.<id>:<password>@aws-0-eu-west-2.pooler.supabase.com:6543/postgres'
alembic upgrade head
```

You should see all five migrations applied (`0001_users`, `0002_templates`, `0003_jobs_assets_outputs`, `0004_audit_events`, `0005_user_billing`). Verify in the Supabase dashboard → Table Editor that the tables `users`, `templates`, `jobs`, `asset_categories`, `assets`, `outputs`, `audit_events` now exist (the `users` table should have the new `license_*` columns).

For future schema changes, run `alembic revision --autogenerate -m "..."` after editing models, review the generated file, then `alembic upgrade head`.

### 4d.1. Optional new env vars

Two new optional secrets you may want to set:

```bash
fly secrets set CORS_EXTRA_ORIGINS='https://app.example.com' -a printlay   # if SPA is hosted off-Fly
fly secrets set RATE_LIMIT_GENERATE_PER_HOUR=120 -a printlay              # default is 60/user/hour
```

If left unset, defaults are: same-origin only for CORS, 60 PDF generations/user/hour.

### 4d.2. Licensing & billing (optional — leave blank during testing)

Printlay integrates with **License Manager for WooCommerce (LMFWC)** on
`magicalplugins.com` (same install used by the Murphy's Magic Connector). It
is fully isolated: PrintLay licence keys carry a `PL-` prefix, telemetry uses
its own `/wp-json/printlay/v1/` namespace, and the product-install ping
identifies as `PrintLay`.

While these secrets are blank, every signed-in user is treated as
`internal_beta` (unlimited access). The Settings page in the SPA shows
"License server isn't configured" and the activate button is disabled — which
is exactly what you want during product validation.

When you're ready to flip billing on (see "Billing prerequisites" below):

```bash
fly secrets set \
  LICENSE_SERVER_URL='https://magicalplugins.com' \
  LMFWC_CONSUMER_KEY='ck_xxxxxxxxxxxx' \
  LMFWC_CONSUMER_SECRET='cs_xxxxxxxxxxxx' \
  PRINTLAY_PRODUCT_NAME='PrintLay' \
  TELEMETRY_ENABLED=true \
  -a printlay
```

**Billing prerequisites (do these on `magicalplugins.com`, not in this repo):**

1. **Create the WooCommerce product** "PrintLay" (Simple or Variable).
2. **Create LMFWC generators** with the prefixes `PL-STR-`, `PL-PRO-`,
   `PL-EXPERT-` (or whatever final tier names you decide). The PrintLay
   server derives the plan from the prefix, so the exact prefix matters.
3. **Install the telemetry WordPress plugin** (`printlay-telemetry.php`) so
   `/wp-json/printlay/v1/telemetry` exists. The full snippet is in the
   integration handoff doc; without it, telemetry POSTs will 404 silently.
4. **VAT / tax**: confirm WooCommerce tax is configured for the regions
   you'll sell into. The current setup is UK-only — that's fine if you
   restrict initial sales to the UK, but EU/US sales need WooCommerce Tax,
   TaxJar, or Quaderno on the WP side first.
5. **Decide the per-tier limits** in `backend/services/entitlements.py`
   (`PLAN_LIMITS` and `PLAN_FEATURES`) — currently placeholders.

### 4e. First Fly deploy

```bash
fly deploy -a printlay
```

Watch the build. On success, the app is live at `https://printlay.fly.dev`.

### 4f. Verify

```bash
fly status -a printlay
fly logs -a printlay --no-tail | tail -50
curl https://printlay.fly.dev/api/health
# {"status":"ok","environment":"production"}
```

Open https://printlay.fly.dev in a browser — you should see the placeholder hero with the green health check at the bottom.

### 4g. Isolation check (run after deploy)

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
- **P3**: Templates table + Alembic migration, PyMuPDF parser (POSITIONS OCG detection), S3-compatible storage client (Tigris in prod), upload endpoint, Templates list + detail (PDF.js renderer + slot overlay).
- **P4**: PDF generator (auto-fit grid of rect/circles on POSITIONS OCG), generate endpoint, wizard generate-step with live SVG preview.
- **P5**: Jobs table, JobProgrammer (click-to-number + auto-row-order), CRUD endpoints.
- **P6**: Categories + assets tables, asset upload pipeline (PDF normalisation, JPEG thumbs, raster→PDF, SVG→PDF), Catalogue page.
- **P7**: JobFiller with quantity modal, `POST /api/jobs/{id}/fill` filling next-N empty slots in `slot_order`.
- **P8**: PDF compositor (`page.show_pdf_page` per filled slot, fit-centred, POSITIONS OCG turned OFF in output config — verified locally), Outputs table + `/generate` + presigned download.

**Verified locally** by smoke test: generated A4 template → composited a raster asset into 3 of 6 circles → output PDF preserved 841.9×595.3pt artboard byte-exact, POSITIONS OCG persisted as `on: False` in the round-tripped PDF (renders cleanly without slot rectangles).

## What I need from you to take it live

1. Complete steps 1–5 above (git push, Supabase, Fly app + Tigris + secrets, GitHub Actions token).
2. Run `alembic upgrade head` against the Supabase pooler URL (step 4d).
3. `fly deploy -a printlay` (step 4e).
4. Visit `https://printlay.fly.dev`, register an account, then walk:
   - Templates → New template → Generate (e.g. 297×210mm, 55mm circles, 5mm gap) → opens in detail view with overlay.
   - Catalogue → New category → upload a few PNGs/PDFs.
   - Templates → that template → "Program slots →" → click in order or use auto-order rows → Continue.
   - In the filler: click an asset, type a quantity, slots fill. Click "Generate PDF →".
   - Outputs → download the PDF, drop it in VersaWorks → assets land in their exact slot positions, no rectangles visible.

Open items pre-launch:
- **PyMuPDF licensing**. PyMuPDF is AGPL-3.0; using it in a hosted SaaS is generally fine if you're not distributing the binary, but Artifex (the upstream) sells commercial licences if you want to be conservative. Decide before public launch.
- **Email confirmation**. Supabase defaults to requiring email confirmation. If you want to skip it during early testing, Authentication → Providers → Email → toggle "Confirm email" off.
- **Billing wiring (code complete, server-side prerequisites pending).** The
  LMFWC integration is built (`backend/services/lmfwc.py` + `entitlements.py`,
  Settings page in the SPA). To switch billing on you need to (1) create the
  PrintLay WooCommerce product + LMFWC generators, (2) install the
  `printlay-telemetry.php` WP plugin, (3) sort out VAT for non-UK regions, (4)
  fill in the real per-tier limits in `entitlements.PLAN_LIMITS`, then (5)
  set the four `LMFWC_*` / `LICENSE_SERVER_URL` secrets on Fly. See §4d.2.

