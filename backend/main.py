import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from backend.config import get_settings
from backend.rate_limit import limiter
from backend.routers import admin as admin_router
from backend.routers import auth as auth_router
from backend.routers import billing as billing_router
from backend.routers import catalogue as catalogue_router
from backend.routers import changelog as changelog_router
from backend.routers import color_profiles as color_profiles_router
from backend.routers import invites as invites_router
from backend.routers import jobs as jobs_router
from backend.routers import leads as leads_router
from backend.routers import outputs as outputs_router
from backend.routers import sheet_builder as sheet_builder_router
from backend.routers import spot_colors as spot_colors_router
from backend.routers import sticker as sticker_router
from backend.routers import support_access as support_access_router
from backend.routers import templates as templates_router

settings = get_settings()

app = FastAPI(
    title="Printlay",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=None if settings.is_production else r".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(billing_router.router)
app.include_router(templates_router.router)
app.include_router(jobs_router.router)
app.include_router(catalogue_router.router)
app.include_router(color_profiles_router.router)
app.include_router(spot_colors_router.router)
app.include_router(outputs_router.router)
app.include_router(leads_router.router)
app.include_router(invites_router.router)
app.include_router(sticker_router.router)
app.include_router(sheet_builder_router.router)
app.include_router(support_access_router.admin_router)
app.include_router(support_access_router.user_router)
app.include_router(changelog_router.public_router)
app.include_router(changelog_router.admin_router)
app.include_router(admin_router.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "environment": settings.environment}


# ---- Frontend build version ----
# We expose the hash of the main JS bundle so the client can detect when a
# new deploy has happened (lazy chunks change names) and prompt the user to
# refresh BEFORE they hit a 404 on a stale chunk reference. The value is
# extracted once at startup and cached for the life of the process.

_BUILD_HASH: str | None = None
_BUILD_HASH_RE = re.compile(r"/assets/index-([A-Za-z0-9_-]+)\.js")


def _read_build_hash() -> str:
    index = Path(__file__).resolve().parent / "static" / "index.html"
    if not index.exists():
        return "dev"
    try:
        text = index.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return "unknown"
    m = _BUILD_HASH_RE.search(text)
    return m.group(1) if m else "unknown"


@app.get("/api/build")
def build_version() -> dict[str, str]:
    global _BUILD_HASH
    if _BUILD_HASH is None:
        _BUILD_HASH = _read_build_hash()
    return {"build": _BUILD_HASH}


# ---- Static frontend (built React/Vite app) ----
# In Docker the build lands at backend/static/. In local dev (uvicorn --reload)
# the directory does not exist; we skip mounting and let the Vite dev server
# proxy API calls itself.

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Hashed asset filenames are immutable for the lifetime of a deploy, so we
# cache them aggressively. index.html (and any other unhashed file) must
# revalidate every time, otherwise users on stale tabs after a deploy will
# keep loading old chunk URLs that no longer exist (502 / "Failed to fetch
# dynamically imported module").
_IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
_NO_CACHE = "no-cache, no-store, must-revalidate"


class _ImmutableStaticFiles(StaticFiles):
    async def get_response(self, path, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = _IMMUTABLE_CACHE
        return response


def _no_cache_file(path: Path) -> FileResponse:
    return FileResponse(path, headers={"Cache-Control": _NO_CACHE})


if STATIC_DIR.exists():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount(
            "/assets",
            _ImmutableStaticFiles(directory=assets_dir),
            name="assets",
        )

    @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
    def spa_fallback(full_path: str) -> FileResponse | JSONResponse:
        # API routes never reach this handler because they are registered above.
        # Serve a real file if it exists, else hand back index.html so
        # client-side routing (React Router) can take over. index.html is
        # always served with no-cache so a redeploy is picked up immediately.
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            if candidate.suffix in {".html", ".json", ".webmanifest"}:
                return _no_cache_file(candidate)
            return FileResponse(candidate)
        index = STATIC_DIR / "index.html"
        if index.exists():
            return _no_cache_file(index)
        return JSONResponse({"error": "frontend not built"}, status_code=404)
