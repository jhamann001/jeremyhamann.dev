"""
Statement Pipeline — Cloud Run HTTP Server (v2)
===========================================
Wraps the pipeline in a lightweight FastAPI server so Cloud Scheduler
can trigger single-pass scans via HTTP POST.

Also exposes REST API endpoints for the frontend (React preview / product
team integration).

Endpoints:
  POST /scan                         — Run a single scan (scheduler / X-Scan-Secret)
  POST /api/scan                     — Run a single scan (ops role, browser JWT)
  GET  /api/households               — List all households with summary counts
  GET  /api/households/{id}          — Full household detail (accounts + positions)
  GET  /api/households/{id}/pdf      — Download PDF report for a household
  GET  /api/households/export/pdf    — Download combined PDF of all households
  POST /api/households/{id}/save-to-drive — Save PDF to client's Drive Output subfolder (ops only)
  PATCH /api/positions/{id}/status   — Override a position's transfer status
  DELETE /api/positions/{id}         — Soft-delete a position (ops only)
  PATCH /api/positions/{id}/restore  — Restore a soft-deleted position (ops only)
  PATCH /api/accounts/{id}/type      — Override account_type and re-run rule engine
  DELETE /api/accounts/{id}          — Soft-delete an account + positions (ops only)
  PATCH /api/accounts/{id}/restore   — Restore a soft-deleted account (ops only)
  GET  /api/v1/positions              — Positions by account number (OIDC, service-to-service)
  POST /api/v1/holdings-transferability — Read-only Plaid holdings transferability preview (OIDC)
  GET  /api/schedule-status           — Automation schedule & live/asleep state
  GET  /health                       — Health check for Cloud Run (also /api/health, which the demo's Worker,
                                      deploy check and the portfolio site's warm-up call)
  GET  /                             — Basic info

Demo mode (DEMO_MODE=on, see demo.py) adds:
  POST /auth/persona                 — Persona sign-in (form post, 303, signed session cookie)
  POST /auth/sign-out                — Clear the session cookie (form post, 303)
  GET  /api/outbox                   — Slack posts and Drive saves the demo captured (ops only)
  GET  /api/samples                  — The sample statements a visitor can run (ops only)
  POST /api/samples/run              — Run sample households through the pipeline, as a scan would (ops only)
  GET  /api/samples/{key}/documents/{filename} — A sample statement's PDF
  POST /api/internal/demo-reset      — The nightly reset (the Worker's cron, with DEMO_RESET_TOKEN)
and refuses the scheduler, Drive scan, machine-API and MCP routes with 404.
"""

import hashlib
import hmac
import os
import logging
import re
import threading
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import auth as pipeline_auth
import demo
import demo_reset
import stand_ins
from automation_pipeline import (
    run_once,
    build_google_services,
    get_or_create_subfolder,
    upload_pdf_to_folder,
    CANONICAL_ACCOUNT_TYPES,
    reclassify_for_new_account_type,
)
import db as pipeline_db
from pdf_export import generate_household_pdf, generate_all_households_pdf
from samples import SAMPLES, SAMPLES_BY_KEY, render_document, shift_document

ET = ZoneInfo("America/New_York")
log = logging.getLogger("acat-server")
_scan_lock = threading.Lock()
_apex_rules_db_lock = threading.Lock()
_apex_rules_db_singleton = None  # NotionApexRulesDB instance, lazy-loaded


def _get_apex_rules_db():
    """Return a process-wide NotionApexRulesDB cache for inline reclassification.

    Loaded lazily on first use so server boot is unaffected and so frontends
    that never trigger an account-type change don't incur the Notion fetch.
    Failures are logged and surfaced as None — callers must treat None as
    "skip Apex layers" rather than as a hard error.
    """
    global _apex_rules_db_singleton
    if demo.demo_mode():
        return stand_ins.demo_apex_rules()
    if _apex_rules_db_singleton is not None:
        return _apex_rules_db_singleton
    with _apex_rules_db_lock:
        if _apex_rules_db_singleton is not None:
            return _apex_rules_db_singleton
        api_key = os.getenv("NOTION_TOKEN_KEY")
        db_id = os.getenv("NOTION_APEX_RULES_DB_ID")
        if not api_key or not db_id:
            log.warning(
                "Apex rules DB skipped — NOTION_TOKEN_KEY or "
                "NOTION_APEX_RULES_DB_ID not set"
            )
            return None
        try:
            from automation_pipeline import NotionApexRulesDB
            _apex_rules_db_singleton = NotionApexRulesDB(api_key, db_id)
        except Exception as exc:
            log.warning("Failed to load Apex rules DB: %s", exc)
            return None
    return _apex_rules_db_singleton


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    App lifespan: initialize DB pool, run schema migrations, and start
    the MCP Streamable HTTP session manager. The MCP session manager
    MUST be running for /mcp/* requests to succeed — FastAPI's
    `app.mount()` does not propagate the inner app's lifespan, so we
    drive it explicitly here.
    """
    # An externally owned database shares a connection budget: never fall
    # back to uncapped per-request connections or serve on an unready schema.
    fail_closed = pipeline_db.schema_owner_external()
    try:
        pipeline_db.init_pool(minconn=2, maxconn=10)
    except Exception as exc:
        if fail_closed:
            raise
        log.error("Failed to initialize DB pool (will fall back to per-request connections): %s", exc)
    else:
        try:
            conn = pipeline_db.get_connection()
            try:
                pipeline_db.ensure_schema(conn)
                if demo.demo_mode():
                    pipeline_db.upsert_personas(conn, demo.PERSONAS)
            finally:
                pipeline_db.put_connection(conn)
        except Exception as exc:
            if fail_closed:
                raise
            log.error("Failed to run schema migrations on startup: %s", exc)

    # The demo refuses /mcp before routing, so its session manager never starts.
    if demo.demo_mode():
        yield
        return

    # Import here to avoid pulling MCP into module-import time before
    # the FastAPI app is constructed.
    from mcp_server import mcp as mcp_app
    async with mcp_app.session_manager.run():
        yield


app = FastAPI(
    title="ACAT Statement Automation Pipeline",
    description="Deterministic ACAT transfer analysis engine with REST API.",
    version="2.0.0",
    lifespan=lifespan,
)

# The demo is same-origin only: no default development origins may send it credentialed requests.
_default_origins = [] if demo.demo_mode() else ["http://localhost:5173", "http://localhost:3000"]
_env_origins = os.getenv("CORS_ORIGINS", "")
_cors_origins = [o.strip() for o in _env_origins.split(",") if o.strip()] if _env_origins else _default_origins
_cloud_run_url = os.getenv("CLOUD_RUN_URL")
if _cloud_run_url and _cloud_run_url not in _cors_origins:
    _cors_origins.append(_cloud_run_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def demo_guard(request: Request, call_next):
    """
    Demo mode only. The private routes answer 404 before routing (so the SPA
    catch-all can't serve them a page either), and a state-changing request
    must come from this site: sign-in is a cookie, so every POST, PATCH and
    DELETE is otherwise a cross-site forgery target. The reset is the one
    exception: the Worker's cron calls it with a token, not a cookie. A body
    over 128 KB, or one sent without a length, is refused before it is read.
    """
    if demo.demo_mode():
        if demo.is_private_path(request.url.path):
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        if demo.is_unsafe_method(request.method):
            if request.url.path != demo.RESET_PATH and not demo.from_this_site(request.headers):
                return JSONResponse(status_code=403, content={"detail": "Cross-site request refused"})
            if "transfer-encoding" in request.headers:
                return JSONResponse(status_code=411, content={"detail": "Send a Content-Length"})
            length = request.headers.get("content-length", "0")
            if not length.isdigit() or int(length) > demo.MAX_BODY_BYTES:
                return JSONResponse(status_code=413, content={"detail": "Request too large"})
        response = await call_next(request)
        # Server errors carry database and connection details (the SQL, the host); the log keeps them, the
        # visitor gets a plain sentence.
        if response.status_code >= 500:
            return JSONResponse(status_code=response.status_code, content={"detail": DEMO_SERVER_ERROR})
        return response
    return await call_next(request)


DEMO_SERVER_ERROR = "Something went wrong on the demo's side. Try again in a moment."


@app.exception_handler(pipeline_db.PoolBusy)
def _pool_busy(request: Request, exc: pipeline_db.PoolBusy) -> JSONResponse:
    log.warning("Refused %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=503, content={"detail": "The demo is busy. Try again in a moment."})


GOOGLE_CLIENT_ID = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "")
SCAN_SECRET = os.getenv("SCAN_SECRET", "")


def _get_env(key: str, default: str = None) -> str:
    """Get env var or raise clear error."""
    val = os.getenv(key, default)
    if val is None:
        raise HTTPException(
            status_code=500,
            detail=f"Missing required environment variable: {key}",
        )
    return val


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

def _demo_session_user(request: Request) -> dict:
    """
    Demo mode: the user named by the signed session cookie, read fresh from
    the users table so a role change or removal applies at once. 401 when the
    cookie is missing, tampered with or expired; 403 when the user is gone.
    """
    email = demo.verify_session(request.cookies.get(demo.SESSION_COOKIE))
    if email is None:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    try:
        user = pipeline_auth.load_user_or_raise(email)
    except pipeline_auth.AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    persona = demo.persona_by_email(email)
    user["google_name"] = persona["name"] if persona else ""
    user["google_picture"] = ""
    return user


def _ops_only(user: dict) -> dict:
    if user.get("role") != "ops":
        raise HTTPException(status_code=403, detail="Operations role required")
    return user


def get_current_user(request: Request) -> dict:
    """
    Validate the Google ID token from the Authorization header and return
    the matching user row from the database.  Raises 401 if the token is
    missing/invalid or 403 if the email is not in the users table. In demo
    mode the signed session cookie stands in for the token.
    """
    if demo.demo_mode():
        return _demo_session_user(request)
    token = pipeline_auth.extract_bearer_token(request.headers.get("Authorization"))
    if not token:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    try:
        return pipeline_auth.verify_web_user_token(token)
    except pipeline_auth.AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def require_ops(user: dict = Depends(get_current_user)) -> dict:
    """Dependency that enforces ops role."""
    return _ops_only(user)


def _demo_text(**fields: Optional[str]) -> None:
    """Demo mode: refuse free text over its limit (demo.TEXT_LIMITS). It stays in the shared database until the
    nightly reset."""
    if not demo.demo_mode():
        return
    for name, value in fields.items():
        limit = demo.TEXT_LIMITS[name]
        if value is not None and len(value) > limit:
            label = name.replace("_", " ").capitalize()
            raise HTTPException(status_code=400, detail=f"{label} is too long (at most {limit} characters)")


def _demo_full(detail: str) -> HTTPException:
    return HTTPException(status_code=429, detail=f"{detail} The demo resets daily at 07:00 UTC.")


def _demo_room_for_destination(conn, source_folder_id: Optional[str]) -> None:
    """Demo mode: a new destination needs a client that exists and has room for it."""
    if not demo.demo_mode():
        return
    if not source_folder_id or not pipeline_db.folder_has_runs(conn, source_folder_id):
        raise HTTPException(status_code=404, detail="Client not found")
    # Held until the insert that follows commits, so two requests can't both see room for one more.
    pipeline_db.lock_cap(conn, f"destinations:{source_folder_id}")
    if pipeline_db.count_target_accounts(conn, source_folder_id) >= demo.MAX_DESTINATIONS_PER_CLIENT:
        raise _demo_full(f"This client has the {demo.MAX_DESTINATIONS_PER_CLIENT} destinations the demo allows.")


def _ops_portal_edit_audiences() -> set[str]:
    """The audience a service-account token must carry (auth.machine_api_audiences). Read per call so tests
    can patch the environment. Empty when nothing is configured, which refuses every service account."""
    return pipeline_auth.machine_api_audiences()


def _verify_ops_portal_service_account(token: str, *, edit: bool) -> Optional[str]:
    """Caller email when the token is for this service and its caller is on
    the edit allowlist (OPS_PORTAL_EDIT_ALLOWED_SAS) for an edit, or the
    machine-read allowlist (POSITIONS_API_ALLOWED_SAS, the verifier GET
    /api/v1/households uses) for a read; otherwise None."""
    audiences = _ops_portal_edit_audiences()
    if not audiences:
        log.warning("Service-account call refused: no expected audience configured")
        return None
    try:
        claims = pipeline_auth.verify_google_id_token(token)
        if str(claims.get("aud", "")).rstrip("/") not in audiences:
            log.warning("Service-account call refused: token audience not accepted")
            return None
        if edit:
            return pipeline_auth.verify_ops_portal_edit_token(token)
        return pipeline_auth.verify_households_api_token(token)
    except pipeline_auth.AuthError:
        return None


def require_ops_or_ops_portal_service_account(request: Request) -> dict:
    """
    Ops web user, or an edit-allowlisted service account whose token audience
    is this service. Only the seven position/account edit routes, the four
    destination write routes, Save to Drive, and POST /api/scan use this; every
    other ops route stays on require_ops. When the service-account check also
    fails, the web-user error is raised, so browser callers get the same
    responses as require_ops. In demo mode only the session cookie is read.
    """
    if demo.demo_mode():
        return _ops_only(_demo_session_user(request))
    token = pipeline_auth.extract_bearer_token(request.headers.get("Authorization"))
    if not token:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    try:
        user = pipeline_auth.verify_web_user_token(token)
    except pipeline_auth.AuthError as web_exc:
        caller_email = _verify_ops_portal_service_account(token, edit=True)
        if caller_email is None:
            raise HTTPException(status_code=web_exc.status_code, detail=web_exc.detail) from web_exc
        log.info("Ops edit authenticated via service account: %s", caller_email)
        return {"email": caller_email, "role": "ops", "_auth_method": "service_account"}
    return _ops_only(user)


def get_current_user_or_ops_portal_service_account(request: Request) -> dict:
    """
    Any web user (exactly as get_current_user), or a read-allowlisted service
    account whose token audience is this service. Only the household PDF and
    all-clients PDF routes use this; every other get_current_user route stays
    web-user only. When the service-account check also fails, the web-user
    error is raised, so browser callers get the same responses as before.
    In demo mode only the session cookie is read.
    """
    if demo.demo_mode():
        return _demo_session_user(request)
    token = pipeline_auth.extract_bearer_token(request.headers.get("Authorization"))
    if not token:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    try:
        return pipeline_auth.verify_web_user_token(token)
    except pipeline_auth.AuthError as web_exc:
        caller_email = _verify_ops_portal_service_account(token, edit=False)
        if caller_email is None:
            raise HTTPException(status_code=web_exc.status_code, detail=web_exc.detail) from web_exc
        log.info("PDF request authenticated via service account: %s", caller_email)
        return {"email": caller_email, "role": "ops", "_auth_method": "service_account"}


# ---------------------------------------------------------------------------
# Core endpoints
# ---------------------------------------------------------------------------

@app.get("/")
def root():
    index = Path(__file__).parent / "static" / "index.html"
    if index.is_file():
        return FileResponse(str(index))
    return {
        "service": "statement-pipeline",
        "version": "2.0.0",
        "status": "running",
        "timestamp": datetime.now(ET).isoformat(),
    }


@app.get("/health")
@app.get("/api/health")
def health():
    """Cloud Run health check — verifies required config is present. The demo
    needs only its database (DATABASE_URL, or DB_HOST and DB_NAME) and session
    secret: Drive, Gemini and Notion are stand-ins there."""
    if demo.demo_mode():
        required = ["SESSION_SECRET"] + ([] if os.getenv("DATABASE_URL") else ["DB_HOST", "DB_NAME"])
    else:
        required = [
            "GOOGLE_CREDENTIALS_PATH", "INPUT_FOLDER_ID",
            "PROCESSED_FOLDER_ID", "OUTPUT_FOLDER_ID",
            "GCP_PROJECT_ID", "NOTION_TOKEN_KEY", "NOTION_DATABASE_ID",
            "DB_HOST", "DB_NAME",
        ]
    missing = [k for k in required if not os.getenv(k)]
    if missing:
        log.error("Unhealthy: missing %s", ", ".join(missing))  # the demo's visitors see only the status
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "missing_env": missing},
        )

    if demo.demo_mode():
        if not demo.session_configured():
            log.error("Unhealthy: SESSION_SECRET is too short")
            return JSONResponse(
                status_code=503,
                content={"status": "unhealthy", "detail": "SESSION_SECRET is too short"},
            )
    else:
        creds_path = os.getenv("GOOGLE_CREDENTIALS_PATH", "/secrets/credentials.json")
        if not os.path.exists(creds_path):
            return JSONResponse(
                status_code=503,
                content={"status": "unhealthy", "detail": f"Credentials file not found: {creds_path}"},
            )

    try:
        conn = pipeline_db.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        finally:
            pipeline_db.put_connection(conn)
    except Exception as exc:
        log.error("Unhealthy: Postgres connection failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "detail": f"Postgres connection failed: {exc}"},
        )

    return {"status": "healthy"}


def _execute_scan() -> dict:
    """Run a single-pass scan with a process-wide lock (shared by /scan and /api/scan)."""
    log.info("Scan triggered at %s", datetime.now(ET).isoformat())

    if not _scan_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A scan is already in progress")

    try:
        results = run_once(
            credentials_path=_get_env("GOOGLE_CREDENTIALS_PATH", "/secrets/credentials.json"),
            input_folder_id=_get_env("INPUT_FOLDER_ID"),
            processed_folder_id=_get_env("PROCESSED_FOLDER_ID"),
            gcp_project_id=_get_env("GCP_PROJECT_ID"),
            gcp_location=os.getenv("GCP_LOCATION", "us-central1"),
            notion_token_key=_get_env("NOTION_TOKEN_KEY"),
            notion_database_id=_get_env("NOTION_DATABASE_ID"),
            notion_custodian_db_id=os.getenv("NOTION_CUSTODIAN_DB_ID"),
            notion_apex_rules_db_id=os.getenv("NOTION_APEX_RULES_DB_ID"),
            notion_ticker_db_id=os.getenv("NOTION_TICKER_DB_ID"),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.5-flash"),
        )
        return {
            "timestamp": datetime.now(ET).isoformat(),
            "clients_processed": len(results),
            "results": results,
        }
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Scan failed: %s", exc)
        raise HTTPException(status_code=500, detail="Scan failed. Check server logs for details.")
    finally:
        _scan_lock.release()


def _verify_scan_caller(request: Request):
    """
    Authenticate /scan callers via Cloud Scheduler OIDC token or X-Scan-Secret.
    Rejects unauthenticated requests unconditionally.
    """
    token = pipeline_auth.extract_bearer_token(request.headers.get("Authorization"))
    if token:
        try:
            caller_email = pipeline_auth.verify_scan_caller_token(token)
        except pipeline_auth.AuthError as exc:
            raise HTTPException(status_code=403, detail=exc.detail) from exc
        log.info("Scan authenticated via OIDC: %s", caller_email)
        return

    scan_secret_header = request.headers.get("X-Scan-Secret", "")
    if SCAN_SECRET and scan_secret_header:
        if hmac.compare_digest(scan_secret_header.encode("utf-8"), SCAN_SECRET.encode("utf-8")):
            log.info("Scan authenticated via X-Scan-Secret")
            return
        raise HTTPException(status_code=403, detail="Invalid scan secret")

    raise HTTPException(
        status_code=403,
        detail="Authentication required: provide Authorization Bearer (OIDC) or X-Scan-Secret header",
    )


@app.post("/scan")
def scan(request: Request):
    """
    Trigger a single-pass scan of the Drive input folder.

    Called by Cloud Scheduler on a cron schedule (e.g., every 15 minutes).
    Requires OIDC Bearer token (from Scheduler) or X-Scan-Secret header.
    Skips execution outside business hours (Mon–Fri, 8 AM – 7 PM ET).
    """
    _verify_scan_caller(request)

    now = datetime.now(ET)
    is_business_day = now.weekday() < 5
    is_business_hours = is_business_day and BUSINESS_START_HOUR <= now.hour < BUSINESS_END_HOUR
    if not is_business_hours:
        log.info("Scan skipped — outside business hours (%s)", now.strftime("%A %I:%M %p ET"))
        return JSONResponse(status_code=200, content={
            "timestamp": now.isoformat(),
            "skipped": True,
            "reason": "Outside business hours (Mon–Fri, 8 AM – 7 PM ET)",
        })

    payload = _execute_scan()
    return JSONResponse(status_code=200, content=payload)


# ---------------------------------------------------------------------------
# REST API — auth & config
# ---------------------------------------------------------------------------

SCAN_INTERVAL_MINUTES = int(os.getenv("SCAN_INTERVAL_MINUTES", "15"))
BUSINESS_START_HOUR = 8   # 8 AM ET
BUSINESS_END_HOUR = 19    # 7 PM ET (last scan at 6:45/6:55)


@app.get("/api/schedule-status")
def schedule_status():
    """Return whether automated scans are active (business hours) and the scan cadence."""
    now = datetime.now(ET)
    weekday = now.weekday()  # 0=Mon … 6=Sun
    hour = now.hour
    is_business_day = weekday < 5
    is_business_hours = is_business_day and BUSINESS_START_HOUR <= hour < BUSINESS_END_HOUR
    return {
        "active": is_business_hours,
        "scan_interval_minutes": SCAN_INTERVAL_MINUTES,
        "business_hours": f"{BUSINESS_START_HOUR}:00 AM – {BUSINESS_END_HOUR - 12}:00 PM ET",
        "business_days": "Mon–Fri",
        "server_time": now.isoformat(),
    }


@app.get("/api/config")
def get_config():
    """Return public client-side config (no auth required). In demo mode:
    the personas the sign-in screen offers, and no Google client id."""
    if demo.demo_mode():
        return {
            "demo": True,
            "google_client_id": "",
            "personas": [
                {k: p[k] for k in ("key", "name", "title", "role")} for p in demo.PERSONAS
            ],
        }
    return {
        "demo": False,
        "google_client_id": GOOGLE_CLIENT_ID,
    }


def _see_other(location: str) -> Response:
    """A 303 to a same-origin path. The browser resolves it against the URL it
    posted to, so the caller's origin is kept behind any proxy."""
    return Response(status_code=303, headers={"Location": location, "Cache-Control": "no-store"})


@app.post("/auth/persona")
async def persona_sign_in(request: Request):
    """
    Demo persona sign-in, as a plain form post (fields `persona` and `next`).
    The demo guard has already refused a cross-site post. Success sets the
    signed session cookie and answers 303 to `next`; a refusal answers 303 to
    `/?signin_error=<code>`, which the sign-in screen maps to fixed copy.
    """
    if not demo.demo_mode():
        raise HTTPException(status_code=404, detail="Not Found")
    raw = await request.body()
    if len(raw) > 2048:
        return _see_other("/?signin_error=persona")
    try:
        form = parse_qs(raw.decode("utf-8", "replace"), max_num_fields=4)
    except ValueError:  # more fields than a sign-in form has
        return _see_other("/?signin_error=persona")
    persona = demo.persona_by_key((form.get("persona") or [""])[0])
    target = demo.safe_next((form.get("next") or ["/"])[0])
    if persona is None:
        return _see_other("/?signin_error=persona")
    if not demo.session_configured():
        log.error("Persona sign-in refused: SESSION_SECRET is not set")
        return _see_other("/?signin_error=config")
    try:
        # A database call: off the event loop, which every other visitor's request shares.
        user = await run_in_threadpool(pipeline_auth.load_user_or_raise, persona["email"])
    except pipeline_auth.AuthError:
        log.error("Persona sign-in refused: %s is not in the users table", persona["key"])
        return _see_other("/?signin_error=config")
    if user.get("role") != persona["role"]:
        log.error("Persona sign-in refused: %s has role %s", persona["key"], user.get("role"))
        return _see_other("/?signin_error=config")

    response = _see_other(target)
    response.set_cookie(
        demo.SESSION_COOKIE, demo.sign_session(persona["email"]),
        max_age=demo.SESSION_TTL_SECONDS, path="/",
        httponly=True, secure=demo.cookie_secure(), samesite="lax",
    )
    log.info("Persona sign-in: %s", persona["key"])
    return response


@app.post("/auth/sign-out")
def sign_out():
    """Demo sign-out: clear the session cookie and return to the sign-in screen."""
    if not demo.demo_mode():
        raise HTTPException(status_code=404, detail="Not Found")
    response = _see_other("/")
    response.delete_cookie(
        demo.SESSION_COOKIE, path="/", httponly=True, secure=demo.cookie_secure(), samesite="lax",
    )
    return response


@app.get("/api/me")
def get_me(user: dict = Depends(get_current_user)):
    """Return the current authenticated user's profile and role."""
    return {
        "email": user.get("email"),
        "role": user.get("role"),
        "name": user.get("google_name", ""),
        "picture": user.get("google_picture", ""),
    }


@app.post("/api/scan")
def api_scan(user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Trigger a scan from the UI (operations role only). Uses the same lock as POST /scan."""
    log.info("Manual scan requested by %s", user.get("email", ""))
    payload = _execute_scan()
    return JSONResponse(status_code=200, content=payload)


# ---------------------------------------------------------------------------
# REST API — read endpoints (for frontend)
# ---------------------------------------------------------------------------

# The sidebar asks for 500 runs in one page (frontend/src/App.jsx); a smaller cap here silently dropped the
# oldest clients from it. The demo holds at most demo.MAX_RUNS runs.
MAX_HOUSEHOLDS_PER_PAGE = 500


@app.get("/api/households")
def list_households(
    page: int = 1,
    per_page: int = 50,
    include_superseded: bool = False,
    user: dict = Depends(get_current_user),
):
    """Return households with summary counts, most recent first. Paginated."""
    page = max(int(page or 1), 1)
    per_page = max(1, min(int(per_page or 50), MAX_HOUSEHOLDS_PER_PAGE))
    conn = pipeline_db.get_connection()
    try:
        rows = pipeline_db.get_households(conn, page=page, per_page=per_page, include_superseded=include_superseded)
    except Exception as exc:
        log.exception("Failed to list households: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    return rows


_exports = demo.RateLimiter(*demo.EXPORTS_PER_VISITOR)
_export_slots = threading.BoundedSemaphore(demo.CONCURRENT_EXPORTS)


def _visitor(request: Request, user: dict) -> str:
    return demo.visitor_key(request.headers, request.client.host if request.client else None, user.get("email", ""))


@contextmanager
def _demo_export(request: Request, user: dict):
    """Demo mode: making a PDF is the costliest thing a visitor can ask for. Each visitor has an allowance
    (demo.EXPORTS_PER_VISITOR), and only demo.CONCURRENT_EXPORTS are made at once; the rest wait briefly, then
    get a 503 rather than holding the connections everyone else's requests need."""
    if not demo.demo_mode():
        yield
        return
    if not _exports.allow(_visitor(request, user)):
        count, minutes = demo.EXPORTS_PER_VISITOR[0], demo.EXPORTS_PER_VISITOR[1] // 60
        raise HTTPException(status_code=429, detail=f"At most {count} PDFs in {minutes} minutes. Try again shortly.")
    if not _export_slots.acquire(timeout=demo.EXPORT_WAIT_SECONDS):
        raise HTTPException(status_code=503, detail="Busy making other reports. Try again in a moment.")
    try:
        yield
    finally:
        _export_slots.release()


def _validation_review_note(account: dict, positions: list[dict]) -> Optional[str]:
    """The note that keeps a flagged account's positions in REVIEW, or None. Validation flags an account whose
    values don't reconcile with the statement's totals, or that duplicates another account; a new account type
    changes neither."""
    if account.get("validation_status") != "WARNING":
        return None
    for pos in positions:
        if (pos.get("transfer_notes") or "").startswith("Validation Override"):
            return pos["transfer_notes"]
    return "Validation Override: the statement's values need manual verification — positions kept in REVIEW"


@app.get("/api/households/export/pdf")
def get_all_households_pdf(request: Request, user: dict = Depends(get_current_user_or_ops_portal_service_account)):
    """Generate and return a combined PDF report for all active households."""
    with _demo_export(request, user):
        return _all_households_pdf()


def _all_households_pdf() -> Response:
    conn = pipeline_db.get_connection()
    try:
        household_list = pipeline_db.get_households(conn, page=1, per_page=500, include_superseded=False)
        households_detail = []
        for hh in household_list:
            detail = pipeline_db.get_household_detail(conn, hh["id"])
            if detail:
                households_detail.append(detail)
    except Exception as exc:
        log.exception("Failed to fetch households for combined PDF: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not households_detail:
        raise HTTPException(status_code=404, detail="No households found")

    try:
        pdf_bytes = generate_all_households_pdf(households_detail)
    except Exception as exc:
        log.exception("Failed to generate combined PDF: %s", exc)
        raise HTTPException(status_code=500, detail="PDF generation failed")

    filename = f"all_clients_report_{datetime.now(ET).strftime('%Y-%m-%d')}.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/households/{household_id}")
def get_household(household_id: str, user: dict = Depends(get_current_user)):
    """Return full household detail with accounts and positions."""
    conn = pipeline_db.get_connection()
    try:
        result = pipeline_db.get_household_detail(conn, household_id)
    except Exception as exc:
        log.exception("Failed to get household %s: %s", household_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if result is None:
        raise HTTPException(status_code=404, detail="Household not found")
    return result


@app.post("/api/destinations/backfill")
def backfill_destinations(request: Request):
    """One-time: seed destinations for active households processed before this
    feature. Idempotent. Auth: OIDC or X-Scan-Secret. Run AFTER the roster is loaded."""
    _verify_scan_caller(request)
    conn = pipeline_db.get_connection()
    try:
        from automation_pipeline import backfill_all_destinations
        result = backfill_all_destinations(conn)
    except Exception as exc:
        log.exception("Backfill failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    return result


@app.post("/api/staleness/backfill")
def backfill_staleness(request: Request):
    """One-time: recompute stored statement_age_days / is_stale for all accounts
    from their statement_date. The app computes freshness live on read; this
    refreshes the raw columns for direct DB/Warehouse queries. Auth: OIDC or
    X-Scan-Secret."""
    _verify_scan_caller(request)
    conn = pipeline_db.get_connection()
    try:
        from automation_pipeline import backfill_statement_freshness
        result = backfill_statement_freshness(conn)
    except Exception as exc:
        log.exception("Staleness backfill failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    return result


class NewDestination(BaseModel):
    owner: Optional[str] = None
    target_account_type: str


@app.post("/api/clients/{source_folder_id}/destinations")
def add_destination(source_folder_id: str, body: NewDestination, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Create a new destination ('open new account') for a client."""
    _demo_text(owner=body.owner, account_type=body.target_account_type)
    conn = pipeline_db.get_connection()
    try:
        _demo_room_for_destination(conn, source_folder_id)
        target_id = pipeline_db.create_target_account(
            conn, source_folder_id, body.owner, body.target_account_type,
            needs_to_be_opened=True, user=user.get("email", "ops"),
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Failed to add destination for %s: %s", source_folder_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    return {"id": target_id}


class DestinationPatch(BaseModel):
    needs_to_be_opened: Optional[bool] = None
    target_account_type: Optional[str] = None
    existing_apex_number: Optional[str] = None
    owner: Optional[str] = None


@app.patch("/api/destinations/{target_id}")
def patch_destination(target_id: str, body: DestinationPatch, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Update a destination (needs-to-be-opened / type / existing Apex # / owner)."""
    _demo_text(owner=body.owner, account_type=body.target_account_type,
               existing_apex_number=body.existing_apex_number)
    conn = pipeline_db.get_connection()
    try:
        updated = pipeline_db.set_target_account(
            conn, target_id,
            needs_to_be_opened=body.needs_to_be_opened,
            target_account_type=body.target_account_type,
            existing_apex_number=body.existing_apex_number,
            owner=body.owner, user=user.get("email", "ops"),
        )
    except Exception as exc:
        log.exception("Failed to patch destination %s: %s", target_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    if not updated:
        raise HTTPException(status_code=404, detail="Destination not found")
    return {"id": target_id}


@app.delete("/api/destinations/{target_id}")
def delete_destination(target_id: str, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Delete a destination that no source account is mapped to."""
    conn = pipeline_db.get_connection()
    try:
        deleted = pipeline_db.delete_target_account(conn, target_id)
    except pipeline_db.DestinationInUse:
        raise HTTPException(status_code=409, detail="Move its source accounts to another destination first")
    except Exception as exc:
        log.exception("Failed to delete destination %s: %s", target_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    if not deleted:
        raise HTTPException(status_code=404, detail="Destination not found")
    return {"id": target_id, "deleted": True}


class ReassignBody(BaseModel):
    link_id: str
    target_account_id: Optional[str] = None
    source_folder_id: Optional[str] = None
    new_owner: Optional[str] = None
    new_target_account_type: Optional[str] = None


@app.post("/api/source-accounts/reassign")
def reassign_source(body: ReassignBody, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Move a source account to a different destination (existing target_account_id,
    or create a new one via new_target_account_type)."""
    _demo_text(owner=body.new_owner, account_type=body.new_target_account_type)
    conn = pipeline_db.get_connection()
    try:
        # The link decides the client; a folder in the body only has to agree with it.
        folder = pipeline_db.link_folder(conn, body.link_id)
        if folder is None:
            raise HTTPException(status_code=404, detail="Source link not found")
        if body.source_folder_id and body.source_folder_id != folder:
            raise HTTPException(status_code=400, detail="That source account belongs to another client")
        target_id = body.target_account_id
        if not target_id:
            if not body.new_target_account_type:
                raise HTTPException(status_code=400, detail="Provide target_account_id or new_target_account_type + source_folder_id")
            _demo_room_for_destination(conn, folder)
            target_id = pipeline_db.create_target_account(
                conn, folder, body.new_owner, body.new_target_account_type,
                needs_to_be_opened=True, user=user.get("email", "ops"),
            )
        updated = pipeline_db.reassign_link(conn, body.link_id, target_id, user=user.get("email", "ops"))
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Failed to reassign link %s: %s", body.link_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    if not updated:
        raise HTTPException(status_code=404, detail="Destination not found for this client")
    return {"link_id": body.link_id, "target_account_id": target_id}


@app.get("/api/households/{household_id}/pdf")
def get_household_pdf(household_id: str, request: Request,
                      user: dict = Depends(get_current_user_or_ops_portal_service_account)):
    """Generate and return a PDF report for a household."""
    with _demo_export(request, user):
        return _household_pdf(household_id)


def _household_pdf(household_id: str) -> Response:
    conn = pipeline_db.get_connection()
    try:
        result = pipeline_db.get_household_detail(conn, household_id)
    except Exception as exc:
        log.exception("Failed to get household %s for PDF: %s", household_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if result is None:
        raise HTTPException(status_code=404, detail="Household not found")

    try:
        pdf_bytes = generate_household_pdf(result)
    except Exception as exc:
        log.exception("Failed to generate PDF for household %s: %s", household_id, exc)
        raise HTTPException(status_code=500, detail="PDF generation failed")

    client_name = (result.get("client_name") or "export").replace(" ", "_")
    filename = f"{client_name}_report_{datetime.now(ET).strftime('%Y-%m-%d')}.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class DriveSaveResponse(BaseModel):
    file_id: str
    web_view_link: str
    filename: str
    reviewed_at: str
    reviewed_by: str


@app.post("/api/households/{household_id}/save-to-drive", response_model=DriveSaveResponse)
def save_household_to_drive(
    household_id: str,
    request: Request,
    user: dict = Depends(require_ops_or_ops_portal_service_account),
):
    """Generate the household PDF, save it to the client's subfolder in the
    Drive Output folder, and stamp the household as reviewed by this user
    (ops role required). In demo mode the save is captured in the Outbox."""
    if demo.demo_mode():
        with _demo_export(request, user):
            return _save_household_to_outbox(household_id, user)
    output_folder_id = _get_env("OUTPUT_FOLDER_ID")
    credentials_path = _get_env("GOOGLE_CREDENTIALS_PATH")
    reviewer_email = user.get("email", "ops")

    conn = pipeline_db.get_connection()
    try:
        try:
            result = pipeline_db.get_household_detail(conn, household_id)
        except Exception as exc:
            log.exception("Failed to load household %s for Drive save: %s", household_id, exc)
            raise HTTPException(status_code=500, detail=str(exc))

        if result is None:
            raise HTTPException(status_code=404, detail="Household not found")

        try:
            pdf_bytes = generate_household_pdf(result)
        except Exception as exc:
            log.exception("PDF generation failed for %s: %s", household_id, exc)
            raise HTTPException(status_code=500, detail="PDF generation failed")

        raw_client_name = (result.get("client_name") or "export").strip()
        folder_name = raw_client_name.replace("/", "_") or "export"
        safe_name = folder_name.replace(" ", "_")
        timestamp = datetime.now(ET).strftime("%Y-%m-%d_%H%M%S")
        filename = f"{safe_name}_report_{timestamp}.pdf"

        try:
            drive = build_google_services(credentials_path)
            client_folder_id = get_or_create_subfolder(drive, output_folder_id, folder_name)
            uploaded = upload_pdf_to_folder(drive, pdf_bytes, filename, client_folder_id)
        except Exception as exc:
            log.exception("Drive upload failed for %s: %s", household_id, exc)
            raise HTTPException(status_code=502, detail="Drive upload failed")

        try:
            reviewed_at = pipeline_db.mark_household_reviewed(
                conn, household_id, reviewer_email,
            )
        except Exception as exc:
            log.exception("Failed to mark household %s reviewed: %s", household_id, exc)
            raise HTTPException(status_code=500, detail="Failed to mark household reviewed")
    finally:
        pipeline_db.put_connection(conn)

    log.info(
        "Saved PDF to Drive: household=%s file_id=%s user=%s",
        household_id, uploaded.get("id"), reviewer_email,
    )

    return DriveSaveResponse(
        file_id=uploaded["id"],
        web_view_link=uploaded.get("webViewLink", ""),
        filename=filename,
        reviewed_at=reviewed_at.isoformat() if reviewed_at else "",
        reviewed_by=reviewer_email,
    )


def _save_household_to_outbox(household_id: str, user: dict) -> DriveSaveResponse:
    """
    Demo "Save to Drive": the same PDF and the same reviewed stamp, but the
    file is recorded in the Outbox (name, folder, size) instead of uploaded.
    The PDF itself is not kept; Export PDF regenerates it.
    """
    reviewer_email = user.get("email", "ops")
    conn = pipeline_db.get_connection()
    try:
        result = pipeline_db.get_household_detail(conn, household_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Household not found")
        try:
            pdf_bytes = generate_household_pdf(result)
        except Exception as exc:
            log.exception("PDF generation failed for %s: %s", household_id, exc)
            raise HTTPException(status_code=500, detail="PDF generation failed")

        folder_name = (result.get("client_name") or "export").strip().replace("/", "_") or "export"
        filename = f"{folder_name.replace(' ', '_')}_report_{datetime.now(ET).strftime('%Y-%m-%d_%H%M%S')}.pdf"
        entry_id = pipeline_db.insert_outbox_entry(
            conn,
            kind="drive",
            title=f"Output / {folder_name} / {filename}",
            body=f"Household PDF report ({max(1, len(pdf_bytes) // 1024)} KB) saved to the client's folder "
                 f"in the Drive Output folder.",
            meta={"household_id": household_id, "folder": folder_name, "filename": filename,
                  "bytes": len(pdf_bytes)},
            created_by=reviewer_email,
            keep=demo.MAX_OUTBOX,
            commit=False,
        )
        reviewed_at = pipeline_db.mark_household_reviewed(conn, household_id, reviewer_email)
        conn.commit()  # the entry and the stamp together
    finally:
        pipeline_db.put_connection(conn)

    log.info("Captured Drive save in the Outbox: household=%s entry=%s", household_id, entry_id)
    return DriveSaveResponse(
        file_id=entry_id,
        web_view_link="",
        filename=filename,
        reviewed_at=reviewed_at.isoformat() if reviewed_at else "",
        reviewed_by=reviewer_email,
    )


# ---------------------------------------------------------------------------
# REST API — write endpoints (ops overrides, requires ops role)
# ---------------------------------------------------------------------------

class StatusOverride(BaseModel):
    status: str
    notes: str = ""


@app.patch("/api/positions/{position_id}/status")
def override_position_status(
    position_id: str,
    body: StatusOverride,
    user: dict = Depends(require_ops_or_ops_portal_service_account),
):
    """Override a position's transfer status (ops role required)."""
    valid_statuses = {"ACAT", "LIQUIDATE", "UNSUPPORTED", "REVIEW", "ACH/WIRE"}
    if body.status not in valid_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{body.status}'. Must be one of: {', '.join(sorted(valid_statuses))}",
        )
    _demo_text(notes=body.notes)

    conn = pipeline_db.get_connection()
    try:
        updated = pipeline_db.update_position_override(
            conn, position_id, body.status, body.notes, user.get("email", "ops"),
        )
    except Exception as exc:
        log.exception("Failed to update position %s: %s", position_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not updated:
        raise HTTPException(status_code=404, detail="Position not found")

    return {"position_id": position_id, "new_status": body.status, "notes": body.notes}


class TransferringFlag(BaseModel):
    # 'YES' | 'NO' | null (clear)
    value: Optional[str] = None


@app.patch("/api/positions/{position_id}/transferring")
def set_position_transferring(
    position_id: str,
    body: TransferringFlag,
    user: dict = Depends(require_ops_or_ops_portal_service_account),
):
    """Set the ops 'Transferring?' flag on a position (ops role required).
    Accepts 'YES', 'NO', or null to clear. Independent of the rule-engine status."""
    value = body.value
    if value is not None:
        value = value.upper()
        if value not in {"YES", "NO"}:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid value '{body.value}'. Must be 'YES', 'NO', or null.",
            )

    conn = pipeline_db.get_connection()
    try:
        updated = pipeline_db.set_position_transferring(
            conn, position_id, value, user.get("email", "ops"),
        )
    except Exception as exc:
        log.exception("Failed to set transferring on %s: %s", position_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not updated:
        raise HTTPException(status_code=404, detail="Position not found")

    return {"position_id": position_id, "transferring": value}


class AccountTypeOverride(BaseModel):
    account_type: str
    account_type_other: Optional[str] = None


@app.patch("/api/accounts/{account_id}/type")
def override_account_type(
    account_id: str,
    body: AccountTypeOverride,
    user: dict = Depends(require_ops_or_ops_portal_service_account),
):
    """Override an account's classification (account_type) and re-run the
    deterministic rule engine for every non-deleted position in the account.

    Per-position manual `override_status` values are preserved untouched —
    only the engine-computed `transfer_eligible` / `transfer_notes` are
    refreshed. `account_type_raw` (verbatim string from the source
    statement) is also preserved for audit. The Apex rules DB is consulted
    when available; when it cannot be loaded, Apex layers are skipped and
    the response surfaces a warning flag.
    """
    new_type = (body.account_type or "").strip()
    if new_type not in CANONICAL_ACCOUNT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid account_type '{new_type}'. Must be one of: "
                f"{', '.join(sorted(CANONICAL_ACCOUNT_TYPES))}"
            ),
        )
    _demo_text(account_type_other=body.account_type_other)

    conn = pipeline_db.get_connection()
    try:
        loaded = pipeline_db.get_account_for_reclassification(conn, account_id)
        if not loaded:
            raise HTTPException(status_code=404, detail="Account not found")
        account, positions = loaded

        apex_rules_db = _get_apex_rules_db()
        account_fields, position_updates = reclassify_for_new_account_type(
            new_account_type=new_type,
            apex_rules_db=apex_rules_db,
            positions=positions,
            account_type_other=body.account_type_other,
            forced_review_note=_validation_review_note(account, positions),
        )

        engine_status_changed = pipeline_db.apply_account_type_change(
            conn,
            account_id,
            user.get("email", "ops"),
            account_fields,
            position_updates,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Failed to override account_type for %s: %s", account_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    overrides_preserved = sum(1 for p in positions if p.get("override_status"))
    log.info(
        "Account-type override: account=%s new_type=%s by=%s "
        "positions=%d engine_changed=%d overrides_preserved=%d apex_loaded=%s",
        account_id, new_type, user.get("email"),
        len(position_updates), engine_status_changed, overrides_preserved,
        apex_rules_db is not None,
    )

    return {
        "account_id": account_id,
        "account_type": new_type,
        "account_type_other": account_fields.get("account_type_other"),
        "is_rollover": account_fields["is_rollover"],
        "is_inherited": account_fields["is_inherited"],
        "apex_restriction": account_fields["apex_restriction"],
        "positions_reclassified": len(position_updates),
        "engine_status_changed": engine_status_changed,
        "overrides_preserved": overrides_preserved,
        "apex_rules_loaded": apex_rules_db is not None,
    }


@app.delete("/api/positions/{position_id}")
def delete_position(position_id: str, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Soft-delete a position (ops role required)."""
    conn = pipeline_db.get_connection()
    try:
        deleted = pipeline_db.soft_delete_position(conn, position_id, user.get("email", "ops"))
    except Exception as exc:
        log.exception("Failed to delete position %s: %s", position_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not deleted:
        raise HTTPException(status_code=404, detail="Position not found or already deleted")
    return {"position_id": position_id, "deleted": True}


@app.patch("/api/positions/{position_id}/restore")
def restore_position(position_id: str, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Restore a soft-deleted position (ops role required)."""
    conn = pipeline_db.get_connection()
    try:
        restored = pipeline_db.restore_position(conn, position_id)
    except Exception as exc:
        log.exception("Failed to restore position %s: %s", position_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not restored:
        raise HTTPException(status_code=404, detail="Position not found or not deleted")
    return {"position_id": position_id, "restored": True}


@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: str, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Soft-delete an account and all its positions (ops role required)."""
    conn = pipeline_db.get_connection()
    try:
        deleted = pipeline_db.soft_delete_account(conn, account_id, user.get("email", "ops"))
    except Exception as exc:
        log.exception("Failed to delete account %s: %s", account_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not deleted:
        raise HTTPException(status_code=404, detail="Account not found or already deleted")
    return {"account_id": account_id, "deleted": True}


@app.patch("/api/accounts/{account_id}/restore")
def restore_account(account_id: str, user: dict = Depends(require_ops_or_ops_portal_service_account)):
    """Restore a soft-deleted account and its positions (ops role required)."""
    conn = pipeline_db.get_connection()
    try:
        restored = pipeline_db.restore_account(conn, account_id)
    except Exception as exc:
        log.exception("Failed to restore account %s: %s", account_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not restored:
        raise HTTPException(status_code=404, detail="Account not found or not deleted")
    return {"account_id": account_id, "restored": True}


# ---------------------------------------------------------------------------
# REST API — user management (ops role required)
# ---------------------------------------------------------------------------

_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


class UserCreate(BaseModel):
    email: str
    role: str = "advisor"


class UserRoleUpdate(BaseModel):
    role: str


@app.get("/api/users")
def list_users(user: dict = Depends(require_ops)):
    """List all users (ops role required)."""
    conn = pipeline_db.get_connection()
    try:
        users = pipeline_db.list_users(conn)
    except Exception as exc:
        log.exception("Failed to list users: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    if demo.demo_mode():
        for u in users:
            u["persona"] = demo.persona_by_email(u.get("email")) is not None
    return users


@app.post("/api/users", status_code=201)
def create_user(body: UserCreate, user: dict = Depends(require_ops)):
    """Add a new user (ops role required)."""
    if body.role not in ("ops", "advisor"):
        raise HTTPException(status_code=400, detail="Role must be 'ops' or 'advisor'")
    _demo_text(email=body.email)
    if demo.demo_mode() and not _EMAIL.fullmatch(body.email.strip()):
        raise HTTPException(status_code=400, detail="Enter an email address")

    conn = pipeline_db.get_connection()
    try:
        if demo.demo_mode():
            pipeline_db.lock_cap(conn, "users")  # held until create_user commits
            if pipeline_db.count_users(conn) >= demo.MAX_USERS:
                raise _demo_full(f"The demo allows {demo.MAX_USERS} users.")
        new_user = pipeline_db.create_user(conn, body.email, body.role)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        log.exception("Failed to create user: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    return new_user


def _refuse_persona_change(conn, user_id: str) -> None:
    """Demo persona fence: the sign-in personas can't be demoted or removed,
    so one visitor can't lock the next out of a role."""
    if not demo.demo_mode():
        return
    target = pipeline_db.get_user_by_id(conn, user_id)
    if target and demo.persona_by_email(target.get("email")):
        raise HTTPException(status_code=403, detail="The demo's sign-in personas can't be changed")


@app.patch("/api/users/{user_id}")
def update_user_role(user_id: str, body: UserRoleUpdate, user: dict = Depends(require_ops)):
    """Change a user's role (ops role required). Cannot demote the last ops user."""
    if body.role not in ("ops", "advisor"):
        raise HTTPException(status_code=400, detail="Role must be 'ops' or 'advisor'")

    conn = pipeline_db.get_connection()
    try:
        _refuse_persona_change(conn, user_id)
        updated = pipeline_db.update_user_role(conn, user_id, body.role)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("Failed to update user %s: %s", user_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    return updated


@app.delete("/api/users/{user_id}")
def delete_user(user_id: str, user: dict = Depends(require_ops)):
    """Remove a user (ops role required). Cannot delete the last ops user."""
    conn = pipeline_db.get_connection()
    try:
        _refuse_persona_change(conn, user_id)
        deleted = pipeline_db.delete_user(conn, user_id)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("Failed to delete user %s: %s", user_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# REST API — the demo's Outbox (ops role required; demo mode only)
# ---------------------------------------------------------------------------

OUTBOX_LIMIT = 100


@app.get("/api/outbox")
def list_outbox(user: dict = Depends(require_ops)):
    """The Slack posts and Drive saves the demo captured instead of sending, newest first."""
    if not demo.demo_mode():
        raise HTTPException(status_code=404, detail="Not Found")
    conn = pipeline_db.get_connection()
    try:
        return pipeline_db.list_outbox(conn, limit=OUTBOX_LIMIT)
    finally:
        pipeline_db.put_connection(conn)


# ---------------------------------------------------------------------------
# REST API — the demo's sample statements, in place of the Drive input folder (demo mode only)
# ---------------------------------------------------------------------------

def _require_demo() -> None:
    if not demo.demo_mode():
        raise HTTPException(status_code=404, detail="Not Found")


@app.get("/api/samples")
def list_samples(user: dict = Depends(require_ops)):
    """The sample households and what each shows."""
    _require_demo()
    return [
        {
            "key": s.key,
            "client_name": s.client_name,
            "custodian": s.custodian,
            "shows": s.shows,
            "documents": [d.filename for d in s.documents],
            # Statements the pre-screen turns away, so the run's progress can say so.
            "screened_out": [d.filename for d in s.documents if not stand_ins.passes_prescreen(d)],
        }
        for s in SAMPLES
    ]


class SampleRunRequest(BaseModel):
    keys: list[str]


_sample_runs = demo.RateLimiter(*demo.SAMPLE_RUNS_PER_VISITOR)


@app.post("/api/samples/run")
def run_sample_statements(body: SampleRunRequest, request: Request, user: dict = Depends(require_ops)):
    """Run the chosen sample households through the pipeline: the prepared pre-screen and extraction answers,
    then the live rules, the write and the scan summary. Shares the scan lock with POST /scan. Answers at once;
    the panel shows its progress for about a minute before the results, as the real model would take."""
    _require_demo()
    keys = list(dict.fromkeys(body.keys))
    if not keys or any(k not in SAMPLES_BY_KEY for k in keys):
        raise HTTPException(status_code=400, detail="Choose one or more of the sample households")
    visitor = _visitor(request, user)
    # Each household run counts, so one request for every sample can't spend the shared run cap at once.
    if not _sample_runs.allow(visitor, cost=len(keys)):
        runs, minutes = demo.SAMPLE_RUNS_PER_VISITOR[0], demo.SAMPLE_RUNS_PER_VISITOR[1] // 60
        raise HTTPException(status_code=429,
                            detail=f"At most {runs} household runs in {minutes} minutes. Try again later.")
    if not _scan_lock.acquire(blocking=False):
        _sample_runs.refund(visitor, cost=len(keys))
        raise HTTPException(status_code=409, detail="A run is already in progress")
    try:
        conn = pipeline_db.get_connection()
        try:
            # Under the lock, so two runs can't both pass the check.
            if pipeline_db.count_households(conn, include_superseded=True) + len(keys) > demo.MAX_RUNS:
                _sample_runs.refund(visitor, cost=len(keys))
                raise _demo_full(f"The demo has reached its limit of {demo.MAX_RUNS} runs.")
            results = stand_ins.run_samples(keys, conn)
        finally:
            pipeline_db.put_connection(conn)
    finally:
        _scan_lock.release()
    log.info("Sample run by %s: %s", user.get("email"), ", ".join(keys))
    return {"timestamp": datetime.now(ET).isoformat(), "clients_processed": len(results), "results": results}


@app.get("/api/samples/{key}/documents/{filename}")
def sample_document(key: str, filename: str, request: Request, user: dict = Depends(get_current_user)):
    """A sample statement's PDF, with its dates moved to the demo's clock as the extraction reports them."""
    _require_demo()
    sample = SAMPLES_BY_KEY.get(key)
    doc = next((d for d in sample.documents if d.filename == filename), None) if sample else None
    if doc is None:
        raise HTTPException(status_code=404, detail="Sample statement not found")
    with _demo_export(request, user):
        pdf = render_document(shift_document(doc, stand_ins.replay_shift_days()))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{doc.filename}"', "Cache-Control": "private, no-store"},
    )


# How long the reset waits for a sample run in progress (a run takes well under a second on the server).
RESET_LOCK_SECONDS = 120


@app.post(demo.RESET_PATH)
def demo_reset_route(request: Request):
    """The nightly reset (demo_reset.reset_demo), called by the Worker's cron with
    `Authorization: Bearer <DEMO_RESET_TOKEN>`. Waits for a sample run in progress to finish. (The deploy runs
    demo_reset.py directly, before the Worker that holds the token exists.)"""
    _require_demo()
    token = os.getenv("DEMO_RESET_TOKEN", "")
    if not token:
        raise HTTPException(status_code=503, detail="Demo reset is not configured")
    supplied = request.headers.get("authorization", "")
    if not hmac.compare_digest(hashlib.sha256(supplied.encode("utf-8")).digest(),
                               hashlib.sha256(f"Bearer {token}".encode("utf-8")).digest()):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not _scan_lock.acquire(timeout=RESET_LOCK_SECONDS):
        raise HTTPException(status_code=409, detail="A run is still in progress")
    try:
        conn = pipeline_db.get_connection()
        try:
            summary = demo_reset.reset_demo(conn)
        finally:
            pipeline_db.put_connection(conn)
    finally:
        _scan_lock.release()
    return JSONResponse(content=summary, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# REST API — long-lived MCP tokens (ops role required)
# ---------------------------------------------------------------------------

class MCPTokenCreate(BaseModel):
    user_email: str
    description: Optional[str] = None
    ttl_days: Optional[int] = None  # falls back to MCP_TOKEN_TTL_DAYS env var


@app.get("/api/mcp-tokens")
def list_mcp_tokens(user: dict = Depends(require_ops), user_email: Optional[str] = None):
    """List MCP token metadata (ops role required). Never returns the raw token value."""
    conn = pipeline_db.get_connection()
    try:
        tokens = pipeline_db.list_mcp_tokens(conn, user_email=user_email)
    except Exception as exc:
        log.exception("Failed to list MCP tokens: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    return tokens


@app.post("/api/mcp-tokens", status_code=201)
def create_mcp_token(body: MCPTokenCreate, user: dict = Depends(require_ops)):
    """
    Mint a new long-lived MCP token (ops role required).

    The raw token is returned exactly once — clients MUST save it
    immediately. After this response, only the last 4 characters are
    retrievable from the API.
    """
    target_email = (body.user_email or "").strip().lower()
    if not target_email:
        raise HTTPException(status_code=400, detail="user_email is required")

    try:
        result = pipeline_auth.mint_mcp_token(
            user_email=target_email,
            description=(body.description or "").strip(),
            ttl_days=body.ttl_days,
            created_by=user.get("email", "ops"),
        )
    except pipeline_auth.AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except Exception as exc:
        log.exception("Failed to mint MCP token for %s: %s", target_email, exc)
        raise HTTPException(status_code=500, detail="Failed to mint token")

    log.info("MCP token minted: user=%s by=%s id=%s", target_email, user.get("email"), result.get("id"))
    # The body contains a one-time raw token. Forbid intermediary /
    # browser caching so it never lands on disk anywhere unintended.
    return JSONResponse(
        content=jsonable_encoder(result),
        status_code=201,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.delete("/api/mcp-tokens/{token_id}")
def revoke_mcp_token(token_id: str, user: dict = Depends(require_ops)):
    """Revoke an MCP token (ops role required). Idempotent."""
    conn = pipeline_db.get_connection()
    try:
        changed = pipeline_db.revoke_mcp_token(conn, token_id)
    except Exception as exc:
        log.exception("Failed to revoke MCP token %s: %s", token_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)
    log.info("MCP token revoked: id=%s by=%s changed=%s", token_id, user.get("email"), changed)
    return {"id": token_id, "revoked": changed}


# ---------------------------------------------------------------------------
# REST API — service-to-service positions endpoint (OIDC auth)
# ---------------------------------------------------------------------------

def _verify_positions_api_caller(request: Request):
    """
    Authenticate callers to the positions API via OIDC identity token.
    Only service accounts listed in POSITIONS_API_ALLOWED_SAS are accepted.
    """
    token = pipeline_auth.extract_bearer_token(request.headers.get("Authorization"))
    if not token:
        raise HTTPException(status_code=401, detail="Missing Authorization Bearer token")
    try:
        caller_email = pipeline_auth.verify_positions_api_token(token)
    except pipeline_auth.AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    log.info("Positions API authenticated: %s", caller_email)


@app.get("/api/v1/positions", dependencies=[Depends(_verify_positions_api_caller)])
def get_positions_by_account(
    account_number: Optional[str] = None,
    account_id: Optional[str] = None,
):
    """
    Return positions for an account number (service-to-service, OIDC auth).
    Uses the positions_effective view so overrides and soft-deletes are applied.
    Returns unmasked account numbers for downstream system matching.
    """
    if bool(account_number) == bool(account_id):
        raise HTTPException(status_code=400, detail="Provide exactly one of account_number or account_id")
    if account_id:
        from uuid import UUID
        try:
            account_id = str(UUID(account_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid source account ID") from None
    if account_number and len(account_number) > 100:
        raise HTTPException(status_code=400, detail="Account number is too long")

    conn = pipeline_db.get_connection()
    try:
        result = (pipeline_db.get_positions_by_account_id(conn, account_id) if account_id
                  else pipeline_db.get_positions_by_account_number(conn, account_number))
    except pipeline_db.AmbiguousAccountNumberError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        log.exception("Failed to fetch source positions")
        raise HTTPException(status_code=500, detail="Failed to fetch source positions") from exc
    finally:
        pipeline_db.put_connection(conn)

    if result is None:
        raise HTTPException(status_code=404, detail="Account not found")

    return result


@app.get("/api/v1/position-accounts", dependencies=[Depends(_verify_positions_api_caller)])
def search_position_accounts(q: str = ""):
    if not 2 <= len(q.strip()) <= 100:
        raise HTTPException(status_code=400, detail="Search must contain 2 to 100 characters")
    conn = pipeline_db.get_connection()
    try:
        return pipeline_db.search_position_accounts(conn, q.strip())
    finally:
        pipeline_db.put_connection(conn)


_PREVIEW_ROW_LIMIT = 200
_PREVIEW_TIMEOUT_SECONDS = 4.0


def _preview_inputs(body: object) -> list[dict]:
    """Allowlist symbol, name, and security_type. Drop every other field."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected an object")
    raw_rows = body.get("rows")
    if not isinstance(raw_rows, list):
        raise HTTPException(status_code=400, detail="rows must be a list")
    if len(raw_rows) > _PREVIEW_ROW_LIMIT:
        raise HTTPException(status_code=400, detail="Too many rows")
    cleaned = []
    for raw in raw_rows:
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="Each row must be an object")
        cleaned.append({
            "symbol": raw.get("symbol") if isinstance(raw.get("symbol"), str) else None,
            "name": raw.get("name") if isinstance(raw.get("name"), str) else None,
            "security_type": raw.get("security_type") if isinstance(raw.get("security_type"), str) else None,
        })
    return cleaned


def _preview_apex_asset_rule(asset_type: str):
    """In-memory Apex asset rule, never the Mutual Fund Companies rule."""
    if asset_type == "Mutual Fund":
        return None
    rules = _get_apex_rules_db()
    if rules is None:
        return None
    rule = rules.lookup_asset(asset_type)
    if rule and "Mutual Fund Companies" in str(rule.get("account_type") or ""):
        return None
    return rule


@app.post(
    "/api/v1/holdings-transferability",
    dependencies=[Depends(_verify_positions_api_caller)],
)
async def holdings_transferability_preview(request: Request):
    """Read-only transferability labels for one holdings preview.

    Runs the in-memory classifier. Does not write a household, touch Drive
    or Slack, link a client, or open the pipeline database.
    """
    from holdings_transferability import (
        classify_plaid_holdings_preview,
        preview_restriction_callables,
    )

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Expected JSON") from None
    rows = _preview_inputs(body)
    query_symbols, check_symbol = preview_restriction_callables(_PREVIEW_TIMEOUT_SECONDS)
    result = classify_plaid_holdings_preview(
        rows,
        query_symbols=query_symbols,
        check_symbol=check_symbol,
        apex_asset_rule=_preview_apex_asset_rule,
        timeout_seconds=_PREVIEW_TIMEOUT_SECONDS,
    )
    log.info(
        "Holdings transferability preview: rows=%d rules=%s",
        len(result["rows"]),
        result["rules_status"],
    )
    return JSONResponse(
        content=result,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


def _verify_households_api_caller(request: Request):
    """
    Authenticate callers to the bulk households API via OIDC identity token.
    Only service accounts listed in POSITIONS_API_ALLOWED_SAS are accepted —
    one machine-read allowlist, shared with /api/v1/positions.
    """
    token = pipeline_auth.extract_bearer_token(request.headers.get("Authorization"))
    if not token:
        raise HTTPException(status_code=401, detail="Missing Authorization Bearer token")
    try:
        caller_email = pipeline_auth.verify_households_api_token(token)
    except pipeline_auth.AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    log.info("Households API authenticated: %s", caller_email)


@app.get("/api/v1/households", dependencies=[Depends(_verify_households_api_caller)])
def get_households_bulk_api(
    page: int = 1,
    per_page: int = 100,
    include_superseded: bool = False,
):
    """
    Bulk paginated read of households -> accounts -> positions for
    service-to-service ingest (OIDC auth, same SA allowlist as
    /api/v1/positions). Returns UNMASKED account numbers for downstream
    system matching. Positions use positions_effective (overrides applied,
    soft-deletes excluded); statement freshness is recomputed live.

    By default only live households (superseded_by IS NULL) are returned; pass
    include_superseded=true to include older runs.

    """
    page, per_page, offset = pipeline_db.bulk_query_bounds(
        page, per_page, MAX_HOUSEHOLDS_PER_PAGE
    )

    conn = pipeline_db.get_connection()
    try:
        total = pipeline_db.count_households(conn, include_superseded=include_superseded)
        households = pipeline_db.get_households_bulk(
            conn, limit=per_page, offset=offset, include_superseded=include_superseded
        )
    except Exception as exc:
        log.exception("Failed bulk households read: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        pipeline_db.put_connection(conn)

    return {
        "page": page,
        "per_page": per_page,
        "total": total,
        "households": households,
    }


@app.get(
    "/api/v1/clients/{source_folder_id}/destinations",
    dependencies=[Depends(_verify_households_api_caller)],
)
def get_client_destinations_api(source_folder_id: str):
    """
    Read-only destinations for one client (source folder), for service-to-service
    callers on the same allowlist as /api/v1/households. Returns
    get_destinations_for_client with each source account number masked exactly
    as GET /api/households/{id} masks it. Browser users keep using household
    detail; this route never writes.
    """
    conn = pipeline_db.get_connection()
    try:
        destinations = pipeline_db.get_destinations_for_client(conn, source_folder_id)
    except Exception as exc:
        log.warning("Destinations read failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=500, detail="Failed to read destinations") from None
    finally:
        pipeline_db.put_connection(conn)
    for d in destinations:
        for s in d.get("sources", []):
            s["account_number"] = pipeline_db._mask_account_number(s.get("account_number"))
    return {"destinations": destinations}


# ---------------------------------------------------------------------------
# Remote MCP server (mounted before the SPA catch-all so /mcp isn't swallowed)
# ---------------------------------------------------------------------------

from mcp_server import build_mcp_app  # noqa: E402  (after app is defined)

app.mount("/mcp", build_mcp_app())


# ---------------------------------------------------------------------------
# Static frontend (served from Docker build output)
# ---------------------------------------------------------------------------

_FRONTEND_DIR = Path(__file__).parent / "static"

if _FRONTEND_DIR.is_dir():
    _assets_dir = _FRONTEND_DIR / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="static-assets")

    _FRONTEND_ROOT = _FRONTEND_DIR.resolve()
    _INDEX_HTML = _FRONTEND_ROOT / "index.html"

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve built frontend files; fall back to index.html for SPA routing.

        The requested path is resolved and confirmed to stay within the frontend
        directory before serving, so URL-encoded traversal sequences (``..%2f``,
        which FastAPI decodes to ``../`` before this handler runs) cannot escape
        the static root to read arbitrary files off the container filesystem.
        """
        try:
            candidate = (_FRONTEND_ROOT / full_path).resolve()
        except (OSError, ValueError, RuntimeError):
            return FileResponse(str(_INDEX_HTML))
        if candidate.is_file() and candidate.is_relative_to(_FRONTEND_ROOT):
            return FileResponse(str(candidate))
        return FileResponse(str(_INDEX_HTML))
