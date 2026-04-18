from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from backend.config import get_settings
from backend.rate_limit import limiter
from backend.routers import auth as auth_router
from backend.routers import billing as billing_router
from backend.routers import catalogue as catalogue_router
from backend.routers import jobs as jobs_router
from backend.routers import outputs as outputs_router
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
app.include_router(outputs_router.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "environment": settings.environment}


# ---- Static frontend (built React/Vite app) ----
# In Docker the build lands at backend/static/. In local dev (uvicorn --reload)
# the directory does not exist; we skip mounting and let the Vite dev server
# proxy API calls itself.

STATIC_DIR = Path(__file__).resolve().parent / "static"

if STATIC_DIR.exists():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
    def spa_fallback(full_path: str) -> FileResponse | JSONResponse:
        # API routes never reach this handler because they are registered above.
        # Serve a real file if it exists, else hand back index.html so
        # client-side routing (React Router) can take over.
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        index = STATIC_DIR / "index.html"
        if index.exists():
            return FileResponse(index)
        return JSONResponse({"error": "frontend not built"}, status_code=404)
