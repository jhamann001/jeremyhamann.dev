"""
Statement Pipeline — Remote MCP Server
==================================
Exposes a subset of the Statement Pipeline's functionality as MCP tools over
Streamable HTTP. Mounted as an ASGI sub-app at /mcp on the main FastAPI
service.

Auth: every request must carry `Authorization: Bearer <google-id-token>`
matching the same allowlist used by the web UI. This targets Claude
Code; Claude.ai (which requires OAuth 2.1) is not supported in v1.

Tools (v1):
  list_households                  any role
  get_household                    any role
  get_household_pdf                any role
  export_all_households_pdf        any role
  override_position_status         ops role only
  save_household_to_drive          ops role only
  get_schedule_status              any role
"""

from __future__ import annotations

import base64
import logging
import os
import threading
from collections import OrderedDict
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

import auth as pipeline_auth
from automation_pipeline import (
    build_google_services,
    get_or_create_subfolder,
    upload_pdf_to_folder,
)
import db as pipeline_db
from pdf_export import generate_household_pdf, generate_all_households_pdf

ET = ZoneInfo("America/New_York")
log = logging.getLogger("acat-mcp")

SCAN_INTERVAL_MINUTES = int(os.getenv("SCAN_INTERVAL_MINUTES", "15"))
BUSINESS_START_HOUR = 8
BUSINESS_END_HOUR = 19
VALID_POSITION_STATUSES = {"ACAT", "LIQUIDATE", "UNSUPPORTED", "REVIEW", "ACH/WIRE"}

# Hard cap on per_page to keep tool callers from accidentally (or
# deliberately) asking for a multi-million-row response.
MAX_HOUSEHOLDS_PER_PAGE = 200

# Lower-cased header name used by the MCP Streamable HTTP transport.
_MCP_SESSION_HEADER = "mcp-session-id"

# Tracks which user's Bearer token was used to OPEN each MCP session, so
# we can reject requests that try to reuse another user's session id.
# Bounded LRU keeps memory in check; with min/max=1 instances and the
# SDK's idle timeout, real usage stays well under the cap.
_SESSION_OWNERS_MAX = 10000
_session_owners_lock = threading.Lock()
_session_owners: "OrderedDict[str, str]" = OrderedDict()


def _get_session_owner(session_id: str) -> Optional[str]:
    with _session_owners_lock:
        owner = _session_owners.get(session_id)
        if owner is not None:
            _session_owners.move_to_end(session_id)
        return owner


def _set_session_owner(session_id: str, email: str) -> None:
    with _session_owners_lock:
        _session_owners[session_id] = email
        _session_owners.move_to_end(session_id)
        while len(_session_owners) > _SESSION_OWNERS_MAX:
            _session_owners.popitem(last=False)


def _current_user(ctx: Optional[Context] = None) -> dict:
    """
    Return the user dict for the current MCP tool invocation.

    The user is set on the per-request Starlette Request by
    BearerAuthMiddleware. Reading it off `ctx.request_context.request`
    is the correct path in both transport modes. It is especially
    important in the SDK's stateful mode, where each session runs in a
    long-lived task whose contextvars snapshot is the SESSION CREATOR's
    request — a module-level ContextVar set by Starlette middleware would
    return the session creator on every subsequent call. We run in
    stateless mode (see the FastMCP constructor below), so there is one
    request per tool invocation and this simply returns the caller.
    """
    if ctx is not None:
        try:
            request = ctx.request_context.request
        except Exception:  # pragma: no cover — defensive; ctx is always present in tools
            request = None
        if request is not None:
            user = getattr(request.state, "user", None)
            if user is not None:
                return user
            user = request.scope.get("acat_user") if hasattr(request, "scope") else None
            if user is not None:
                return user
    raise RuntimeError("Tool invoked outside an authenticated request context")


def _require_ops(ctx: Optional[Context] = None) -> dict:
    user = _current_user(ctx)
    if user.get("role") != "ops":
        raise PermissionError("Operations role required for this tool")
    return user


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """
    Verify `Authorization: Bearer <token>` on every MCP request. Accepts
    two token shapes:
        * Long-lived MCP tokens minted via /api/mcp-tokens (prefix
          `eg_mcp_`, looked up in the DB by hash). Preferred path.
        * Google ID tokens issued for the web app's OAuth client
          (legacy path, expires in ~1 hour).

    On success the resolved user dict is attached to the per-request
    Starlette Request (state + scope); tool handlers read it through
    the FastMCP `Context` parameter via `_current_user(ctx)`. We also
    pin the MCP session id to the user that opened it to prevent
    cross-user session reuse.
    """

    async def dispatch(self, request, call_next):
        token = pipeline_auth.extract_bearer_token(request.headers.get("authorization"))
        if not token:
            return JSONResponse(
                {"error": "unauthorized", "detail": "Missing Authorization Bearer token"},
                status_code=401,
            )
        try:
            user = pipeline_auth.verify_bearer_token(token)
        except pipeline_auth.AuthError as exc:
            return JSONResponse(
                {"error": "unauthorized", "detail": exc.detail},
                status_code=exc.status_code,
            )

        # Reject attempts to attach to another user's session. The MCP
        # session is a stateful resource opened by one bearer; allowing
        # another user to reuse the session id would let them inherit
        # the session-creator's identity inside tool handlers (the
        # session task's contextvar snapshot doesn't change per
        # request). In stateless mode the SDK issues no session-id header
        # so this block is inert, but it is kept as belt-and-suspenders
        # in case the transport is ever switched back to stateful.
        user_email = (user.get("email") or "").lower()
        incoming_session = request.headers.get(_MCP_SESSION_HEADER)
        if incoming_session:
            owner = _get_session_owner(incoming_session)
            if owner is not None and owner != user_email:
                log.warning(
                    "MCP session ownership mismatch: session=%s owner=%s caller=%s",
                    incoming_session, owner, user_email,
                )
                return JSONResponse(
                    {"error": "forbidden", "detail": "MCP session does not belong to this user"},
                    status_code=403,
                )

        # Stash the user on the per-request Starlette Request so tool
        # handlers can read it off ctx.request_context.request.state.
        # Setting both .state and .scope covers any Request rebuilt
        # from the same scope downstream (the SDK does this).
        request.state.user = user
        request.scope["acat_user"] = user

        log.info(
            "MCP request authenticated: %s (%s) via %s",
            user.get("email"), user.get("role"), user.get("_auth_method", "google_id_token"),
        )

        response = await call_next(request)

        # If the SDK just minted a new session id, record its owner so
        # future requests with that id are pinned to this user.
        new_session = response.headers.get(_MCP_SESSION_HEADER)
        if new_session and not incoming_session and user_email:
            _set_session_owner(new_session, user_email)

        return response


# Backwards-compat alias (in case anything imports the old name).
GoogleIDTokenAuthMiddleware = BearerAuthMiddleware


def _build_transport_security() -> TransportSecuritySettings:
    """
    FastMCP's DNS-rebinding protection blocks any Host header that's not
    in `allowed_hosts`. The SDK's defaults only cover localhost, so we
    have to explicitly allow the public Cloud Run hostname (or any other
    front-end domain) — otherwise every request returns 421 Invalid
    Host header before reaching the auth middleware.

    Allowed hosts come from (in priority order):
      * MCP_ALLOWED_HOSTS — comma-separated list, exact matches.
      * CLOUD_RUN_URL — the hostname is extracted (the env var is
        already used elsewhere for CORS, so reuse the same convention).
      * Local-dev defaults (127.0.0.1:*, localhost:*, [::1]:*).

    Origins follow the same pattern but include the scheme.
    """
    from urllib.parse import urlparse

    allowed_hosts: list[str] = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
    allowed_origins: list[str] = [
        "http://127.0.0.1:*",
        "http://localhost:*",
        "http://[::1]:*",
    ]

    extra_hosts = [h.strip() for h in os.getenv("MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]
    extra_origins = [o.strip() for o in os.getenv("MCP_ALLOWED_ORIGINS", "").split(",") if o.strip()]

    cloud_run_url = os.getenv("CLOUD_RUN_URL", "").strip()
    if cloud_run_url:
        parsed = urlparse(cloud_run_url)
        if parsed.netloc:
            extra_hosts.append(parsed.netloc)
        if parsed.scheme and parsed.netloc:
            extra_origins.append(f"{parsed.scheme}://{parsed.netloc}")

    allowed_hosts.extend(extra_hosts)
    allowed_origins.extend(extra_origins)
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
    )


# streamable_http_path="/" makes FastMCP's inner Starlette app serve the
# transport at the root of its own mount. We then mount this whole app
# at /mcp in server.py, so the external URL is /mcp (without a /mcp/mcp
# duplication caused by the SDK's default of /mcp).
#
# stateless_http=True is REQUIRED for our Cloud Run deployment. The
# default (stateful) transport keeps per-session state in the memory of
# a single instance and hands the client an `Mcp-Session-Id` to resume
# it. With min/max scale of 2–4 instances and no session affinity, a
# follow-up or reconnect request round-robins to a different instance
# that never saw that session, and the SDK answers `404 Session not
# found` — the reconnect failures we were seeing. In stateless mode each
# HTTP request is fully self-contained (fresh transport per request, no
# server-side session, no session-id header), so any instance can serve
# any request. Our tools are all simple request/response calls, so we
# don't rely on the stateful-only features (server-initiated
# notifications, resource subscriptions, long-lived GET streams).
mcp = FastMCP(
    "statement-pipeline",
    streamable_http_path="/",
    stateless_http=True,
    transport_security=_build_transport_security(),
)


# ---------------------------------------------------------------------------
# Read tools (any authenticated user)
# ---------------------------------------------------------------------------

@mcp.tool()
def list_households(
    page: int = 1,
    per_page: int = 50,
    include_superseded: bool = False,
    ctx: Optional[Context] = None,
) -> list[dict]:
    """
    List households with summary counts, most recent first. Paginated.

    Args:
        page: 1-indexed page number.
        per_page: Page size (default 50, capped at 200).
        include_superseded: Include households whose statements have been
            replaced by newer scans. Defaults to False (active only).
    """
    user = _current_user(ctx)
    page = max(int(page or 1), 1)
    per_page = max(1, min(int(per_page or 50), MAX_HOUSEHOLDS_PER_PAGE))
    log.info("list_households by %s (page=%s, per_page=%s)", user.get("email"), page, per_page)
    conn = pipeline_db.get_connection()
    try:
        return pipeline_db.get_households(
            conn, page=page, per_page=per_page, include_superseded=include_superseded,
        )
    finally:
        pipeline_db.put_connection(conn)


@mcp.tool()
def get_household(household_id: str, ctx: Optional[Context] = None) -> dict:
    """
    Return full household detail — accounts and positions with their
    current transfer-eligibility classifications and any ops overrides.

    Args:
        household_id: UUID of the household.
    """
    user = _current_user(ctx)
    log.info("get_household %s by %s", household_id, user.get("email"))
    conn = pipeline_db.get_connection()
    try:
        result = pipeline_db.get_household_detail(conn, household_id)
    finally:
        pipeline_db.put_connection(conn)
    if result is None:
        raise ValueError(f"Household not found: {household_id}")
    return result


@mcp.tool()
def get_household_pdf(household_id: str, ctx: Optional[Context] = None) -> dict:
    """
    Generate a PDF transfer-eligibility report for one household.

    Returns a dict with `filename`, `mime_type`, and `content_base64` —
    the PDF bytes are base64-encoded. Decode with:
        base64.b64decode(result["content_base64"])

    Args:
        household_id: UUID of the household.
    """
    user = _current_user(ctx)
    log.info("get_household_pdf %s by %s", household_id, user.get("email"))
    conn = pipeline_db.get_connection()
    try:
        detail = pipeline_db.get_household_detail(conn, household_id)
    finally:
        pipeline_db.put_connection(conn)
    if detail is None:
        raise ValueError(f"Household not found: {household_id}")

    pdf_bytes = generate_household_pdf(detail)
    client_name = (detail.get("client_name") or "export").replace(" ", "_")
    filename = f"{client_name}_report_{datetime.now(ET).strftime('%Y-%m-%d')}.pdf"
    return {
        "filename": filename,
        "mime_type": "application/pdf",
        "content_base64": base64.b64encode(pdf_bytes).decode("ascii"),
    }


@mcp.tool()
def export_all_households_pdf(ctx: Optional[Context] = None) -> dict:
    """
    Generate a combined PDF report for every active (non-superseded)
    household. Returns the same shape as `get_household_pdf`:
    `filename`, `mime_type`, `content_base64`.

    Can take 20–60 seconds for large datasets.
    """
    user = _current_user(ctx)
    log.info("export_all_households_pdf by %s", user.get("email"))
    conn = pipeline_db.get_connection()
    try:
        household_list = pipeline_db.get_households(conn, page=1, per_page=500, include_superseded=False)
        households_detail = []
        for hh in household_list:
            detail = pipeline_db.get_household_detail(conn, hh["id"])
            if detail:
                households_detail.append(detail)
    finally:
        pipeline_db.put_connection(conn)

    if not households_detail:
        raise ValueError("No households found")

    pdf_bytes = generate_all_households_pdf(households_detail)
    filename = f"all_clients_report_{datetime.now(ET).strftime('%Y-%m-%d')}.pdf"
    return {
        "filename": filename,
        "mime_type": "application/pdf",
        "content_base64": base64.b64encode(pdf_bytes).decode("ascii"),
    }


@mcp.tool()
def get_schedule_status(ctx: Optional[Context] = None) -> dict:
    """
    Return whether the automated scanner is currently active (business
    hours) and the scan cadence.
    """
    _current_user(ctx)
    now = datetime.now(ET)
    is_business_day = now.weekday() < 5
    is_business_hours = is_business_day and BUSINESS_START_HOUR <= now.hour < BUSINESS_END_HOUR
    return {
        "active": is_business_hours,
        "scan_interval_minutes": SCAN_INTERVAL_MINUTES,
        "business_hours": f"{BUSINESS_START_HOUR}:00 AM – {BUSINESS_END_HOUR - 12}:00 PM ET",
        "business_days": "Mon–Fri",
        "server_time": now.isoformat(),
    }


# ---------------------------------------------------------------------------
# Write tools (ops role only)
# ---------------------------------------------------------------------------

@mcp.tool()
def override_position_status(
    position_id: str,
    status: str,
    notes: str = "",
    ctx: Optional[Context] = None,
) -> dict:
    """
    Override a position's transfer-eligibility status. Ops role required.

    Args:
        position_id: UUID of the position to override.
        status: One of ACAT, LIQUIDATE, UNSUPPORTED, REVIEW, ACH/WIRE.
        notes: Optional free-text reason for the override.
    """
    user = _require_ops(ctx)
    if status not in VALID_POSITION_STATUSES:
        raise ValueError(
            f"Invalid status '{status}'. Must be one of: {', '.join(sorted(VALID_POSITION_STATUSES))}"
        )
    log.info("override_position_status %s -> %s by %s", position_id, status, user.get("email"))
    conn = pipeline_db.get_connection()
    try:
        updated = pipeline_db.update_position_override(
            conn, position_id, status, notes, user.get("email", "ops"),
        )
    finally:
        pipeline_db.put_connection(conn)
    if not updated:
        raise ValueError(f"Position not found: {position_id}")
    return {"position_id": position_id, "new_status": status, "notes": notes}


@mcp.tool()
def save_household_to_drive(household_id: str, ctx: Optional[Context] = None) -> dict:
    """
    Generate the household PDF and upload it to the client's subfolder
    in the Drive Output folder. Ops role required.

    Returns `file_id`, `web_view_link`, and `filename`.
    """
    user = _require_ops(ctx)
    output_folder_id = os.getenv("OUTPUT_FOLDER_ID")
    credentials_path = os.getenv("GOOGLE_CREDENTIALS_PATH")
    if not output_folder_id or not credentials_path:
        raise RuntimeError("Drive save is not configured (OUTPUT_FOLDER_ID / GOOGLE_CREDENTIALS_PATH)")

    log.info("save_household_to_drive %s by %s", household_id, user.get("email"))
    conn = pipeline_db.get_connection()
    try:
        detail = pipeline_db.get_household_detail(conn, household_id)
    finally:
        pipeline_db.put_connection(conn)
    if detail is None:
        raise ValueError(f"Household not found: {household_id}")

    pdf_bytes = generate_household_pdf(detail)

    raw_client_name = (detail.get("client_name") or "export").strip()
    folder_name = raw_client_name.replace("/", "_") or "export"
    safe_name = folder_name.replace(" ", "_")
    timestamp = datetime.now(ET).strftime("%Y-%m-%d_%H%M%S")
    filename = f"{safe_name}_report_{timestamp}.pdf"

    drive = build_google_services(credentials_path)
    client_folder_id = get_or_create_subfolder(drive, output_folder_id, folder_name)
    uploaded = upload_pdf_to_folder(drive, pdf_bytes, filename, client_folder_id)

    log.info(
        "Saved PDF to Drive via MCP: household=%s file_id=%s user=%s",
        household_id, uploaded.get("id"), user.get("email"),
    )
    return {
        "file_id": uploaded["id"],
        "web_view_link": uploaded.get("webViewLink", ""),
        "filename": filename,
    }


# ---------------------------------------------------------------------------
# ASGI app factory — called from server.py to mount under /mcp.
# ---------------------------------------------------------------------------

def build_mcp_app():
    """
    Return an ASGI app that serves the MCP Streamable HTTP transport with
    Google ID token auth enforced on every request.
    """
    inner = mcp.streamable_http_app()
    return BearerAuthMiddleware(inner)
