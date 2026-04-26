# Printlay

SaaS for print imposition. Upload (or generate) a template with a `POSITIONS`
layer of slot shapes, program the slot order, fill the slots from a reusable
asset catalogue, and export a print-ready PDF whose artboard is preserved
**byte-exact** for RIPs like VersaWorks.

## Status

- v1 build complete: P1 → P9.
- Backend has a passing test suite covering the full PDF pipeline (parser,
  generator, compositor, asset normalisation, bundle round-trip).
- Frontend builds clean, code-split per route.
- Deferred until first user feedback: theming/branding settings,
  multi-page templates, OAuth provider buttons beyond Google.

## Stack

- **App hosting:** Fly.io (single Docker app)
- **Frontend:** React 18 + Vite + Tailwind + Framer Motion + pdfjs-dist
- **Backend:** FastAPI on Python 3.12 (Docker), 3.14-compatible deps for local dev
- **PDF engine:** PyMuPDF (parsing, generation, compositing, OCG toggling)
- **Raster pipeline:** Pillow → embedded JPEG @ 300 DPI
- **SVG pipeline:** cairosvg → PDF (libcairo2 baked into the runtime image)
- **Auth + DB:** Supabase (Auth + Postgres), JWT verified server-side
- **File storage:** Fly Tigris (S3-compatible, zero egress; auto-provisioned via `fly storage create`). Code is vendor-neutral S3 — drop in R2 / AWS S3 / MinIO by overriding `STORAGE_*` secrets.
- **Rate limiting:** slowapi (in-memory; swap to Redis if we scale to N replicas)
- **CI/CD:** GitHub Actions → `fly deploy` on push to `main`

## Local dev

### Backend

```bash
python3.12 -m venv .venv      # 3.13/3.14 also work locally
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
# health: curl http://localhost:8000/api/health
```

### Tests

```bash
source .venv/bin/activate
pip install pytest
python -m pytest backend/tests -v
```

### Frontend

```bash
cd frontend
npm install
npm run dev          # Vite dev server proxies /api/* to localhost:8000
npm run build        # production bundle in dist/
```

### Full Docker build (mirrors prod)

```bash
docker build -t printlay .
docker run -p 8000:8000 --env-file .env printlay
```

## Environment variables

Copy `.env.example` → `.env` and fill in:

```
SUPABASE_URL=
SUPABASE_ANON_KEY=                           # `sb_publishable_...` (or legacy anon JWT)
SUPABASE_SERVICE_ROLE_KEY=                   # `sb_secret_...` (or legacy service-role JWT)
SUPABASE_JWT_SECRET=                         # only on legacy HS256 projects; modern projects use JWKS
DATABASE_URL=postgres://...                  # Supabase Postgres pooler URL
STORAGE_ENDPOINT=https://fly.storage.tigris.dev
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=
STORAGE_BUCKET=printlay-files
STORAGE_REGION=auto                          # ignored by Tigris; required by some S3 clients
ENVIRONMENT=development                      # `production` locks down CORS
CORS_EXTRA_ORIGINS=                          # CSV of allowed cross-origin SPA origins
RATE_LIMIT_GENERATE_PER_HOUR=60              # ceiling per user on /jobs/{id}/generate
```

In production, set these via `fly secrets set KEY=value` — see `SETUP.md`.

## Architecture at a glance

- **Single Fly app** serves both the SPA (Vite build, copied into the image)
  and the FastAPI backend. The SPA is mounted at `/`; everything under `/api/*`
  is the API.
- **Authentication.** The browser holds a Supabase JWT; the SPA attaches it as
  `Authorization: Bearer ...` to every API call. `backend.auth.jwt` verifies
  signatures with the project's JWT secret and JIT-creates a row in our
  `users` table on first request (`/api/auth/me`).
- **Object storage.** Templates, assets, and outputs live in S3-compatible
  storage (Fly Tigris in production) under `users/{uid}/...` keys. The API
  issues short-lived presigned URLs for downloads so we never proxy large
  bytes through the app.
- **PDF pipeline.**
  - `pdf_parser` extracts page dimensions and the bounding boxes of any
    drawing on the `POSITIONS` OCG layer.
  - `pdf_generator` builds a single-page template from artboard + shape spec,
    drawing rectangles or circles on a fresh `POSITIONS` OCG.
  - `asset_pipeline` normalises every uploaded asset to PDF (raster via Pillow
    → JPEG @ 300 DPI; SVG via cairosvg) and emits a JPEG thumbnail for the UI.
  - `pdf_compositor` opens the template, calls `show_pdf_page` to drop each
    asset PDF scaled-and-centred into its slot's bbox, then sets the
    `POSITIONS` OCG to **off** in the document's default OC config so the slot
    rectangles are hidden in the printed sheet but the file remains
    round-trippable in Illustrator/Acrobat.
- **Catalogue bundles.** Each category exports as a `.printlay.zip`
  containing `manifest.json` + per-asset normalised PDFs and thumbnails.
  Importing mints fresh asset IDs so bundles can be safely shared between
  users without collision.
- **Audit log.** `audit_events` records output generation, bundle import/export,
  and job duplication for support and basic usage analytics.
- **Billing & entitlements.** Stripe-only subscription management: Checkout,
  Customer Portal, and webhooks. A thin `entitlements` layer derives the
  effective plan from `stripe_subscription_status` + `stripe_price_id` +
  `trial_ends_at` (Stripe-first → enterprise admin override → 14-day Pro trial
  → locked). With Stripe secrets unset, new users start a 14-day trial
  automatically and the checkout page gracefully returns a 503.

## Build phases (delivered)

- **P1** Skeleton + Fly + Supabase + S3-compatible storage wiring
- **P2** Auth via Supabase JWT
- **P2.5** Landing page (Gen-Z animated front door)
- **P3** Template wizard — upload path (parse `POSITIONS` shapes)
- **P4** Template wizard — generate path (artboard + shape spec)
- **P5** Job programmer UI (click-to-number, auto-rows, **Shift+drag to sweep**)
- **P6** Asset catalogue (categories, multi-upload, bundle export/import)
- **P7** Job filler (per-asset quantity modal, asset search)
- **P8** PDF compositor + outputs (presigned downloads, deletion)
- **P9** Polish: route-level code-split, error boundary, loading skeletons,
  rate-limit on PDF generation, audit log, job duplication, favicon, CORS
  lockdown, full backend test suite
- **P10** Stripe billing: Checkout, Customer Portal, webhooks, entitlements
  layer (Starter/Pro/Studio/Enterprise), 14-day Pro trial, Founder badge,
  TrialBanner + LockedOverlay in SPA, Admin subscriptions view

## Deploy

Push to `main` → GitHub Actions runs `fly deploy`. See `SETUP.md` for the
one-time bootstrap (Fly app, Supabase project, Tigris bucket, GitHub secrets,
Alembic migrations).
