"""
Shared authentication helpers for the Statement Pipeline.

Centralizes Google ID token verification and allowlist lookups so that
server.py (web UI, scheduler, service-to-service) and mcp_server.py
(MCP tools) share one implementation. Three distinct caller classes are
supported — don't collapse them:

  * Web users        — token audience must be in ACCEPTED_AUDIENCES, and the
                       email must be one Google has verified.
  * Scheduler        — caller email must equal SCAN_ALLOWED_SA and the
                       audience must be in SCAN_EXPECTED_AUDIENCE.
  * Positions API    — caller email must be in POSITIONS_API_ALLOWED_SAS
                       (reads) or OPS_PORTAL_EDIT_ALLOWED_SAS (edits), and the
                       audience must be this service (machine_api_audiences).

Every machine check fails closed: an unset allowlist or audience refuses
every token rather than accepting any Google-signed one.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

import db as pipeline_db

log = logging.getLogger("acat-auth")

# Long-lived MCP token format: "eg_mcp_<43-char-base64url>". The prefix
# lets the auth middleware pick the right verifier without parsing.
MCP_TOKEN_PREFIX = "eg_mcp_"
MCP_TOKEN_BYTES = 32  # → 43-char base64url body
# Default lifetime for a freshly-minted MCP token. Override via
# MCP_TOKEN_TTL_DAYS or the per-mint `ttl_days` field on /api/mcp-tokens.
DEFAULT_MCP_TOKEN_TTL_DAYS = int(os.getenv("MCP_TOKEN_TTL_DAYS", "30"))


class AuthError(Exception):
    """Raised when authentication fails. Carries an HTTP status code."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _accepted_audiences() -> list[str]:
    """Read audiences fresh each call so tests can patch env vars."""
    google_client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "")
    apps_script_client_id = os.getenv("GOOGLE_APPS_SCRIPT_CLIENT_ID", "")
    return [aud for aud in [google_client_id, apps_script_client_id] if aud]


def _expected_audiences_from(env_var: str) -> list[str]:
    """
    Comma-separated allowlist of OIDC token audiences for a given
    endpoint. Returns [] when unset, which callers treat as "refuse every
    token".
    """
    raw = os.getenv(env_var, "").strip()
    return [a.strip() for a in raw.split(",") if a.strip()]


def _allowlist_from(env_var: str) -> list[str]:
    return [sa.strip() for sa in os.getenv(env_var, "").split(",") if sa.strip()]


def machine_api_audiences() -> set[str]:
    """
    The audiences a service-to-service token must carry: the entries of
    POSITIONS_API_EXPECTED_AUDIENCE when set, else this service's own
    CLOUD_RUN_URL, compared without a trailing slash. Empty when neither is
    set, which refuses every machine caller.
    """
    configured = {a.rstrip("/") for a in _expected_audiences_from("POSITIONS_API_EXPECTED_AUDIENCE")}
    if configured:
        return configured
    own_url = os.getenv("CLOUD_RUN_URL", "").strip().rstrip("/")
    return {own_url} if own_url else set()


def _verify_machine_caller(token: str, allowlist_env: str, label: str) -> str:
    """Caller email for a token on *allowlist_env* whose audience is this service; AuthError otherwise."""
    allowed = _allowlist_from(allowlist_env)
    audiences = machine_api_audiences()
    if not allowed or not audiences:
        raise AuthError(503, f"{label} not configured")

    idinfo = verify_google_id_token(token)

    if str(idinfo.get("aud", "")).rstrip("/") not in audiences:
        log.warning("%s token audience %s not in allowlist", label, idinfo.get("aud"))
        raise AuthError(403, f"Token audience not accepted for {label}")

    caller_email = idinfo.get("email", "")
    if caller_email not in allowed:
        log.warning("%s caller %s not in allowed list", label, caller_email)
        raise AuthError(403, "Service account not authorized")
    return caller_email


def verify_google_id_token(token: str) -> dict:
    """
    Verify a Google-issued ID token and return its decoded claims.

    Does not enforce an audience — callers decide which audience set to
    accept (web users, scheduler SA, positions-API SAs). Raises AuthError
    on any verification failure.
    """
    if not token:
        raise AuthError(401, "Missing bearer token")
    try:
        idinfo = google_id_token.verify_oauth2_token(
            token, google_requests.Request(), audience=None,
        )
    except ValueError as exc:
        raise AuthError(401, f"Invalid token: {exc}") from exc
    return idinfo


def verify_web_user_token(token: str) -> dict:
    """
    Verify a token issued for a human web user and return the matching
    user row from the database. Raises AuthError on any failure.
    """
    idinfo = verify_google_id_token(token)

    if idinfo.get("aud") not in _accepted_audiences():
        raise AuthError(401, "Token audience not accepted")

    email = idinfo.get("email", "").lower()
    if not email:
        raise AuthError(401, "Token does not contain an email")
    # The allowlist is keyed by email, so the email must be one Google has verified for this account.
    if idinfo.get("email_verified") is not True:
        raise AuthError(401, "Token email is not verified")

    user = load_user_or_raise(email)
    user["google_name"] = idinfo.get("name", "")
    user["google_picture"] = idinfo.get("picture", "")
    return user


def verify_scan_caller_token(token: str) -> str:
    """
    Verify a Cloud Scheduler OIDC token. Returns caller email on success.

    Fails closed: SCAN_ALLOWED_SA and SCAN_EXPECTED_AUDIENCE (comma-separated)
    must both be set, or every token is refused. With either unset, any
    Google-signed token would otherwise pass.
    """
    allowed_sa = os.getenv("SCAN_ALLOWED_SA", "").strip()
    expected_auds = _expected_audiences_from("SCAN_EXPECTED_AUDIENCE")
    if not allowed_sa or not expected_auds:
        log.warning("Scan OIDC refused: SCAN_ALLOWED_SA or SCAN_EXPECTED_AUDIENCE is not set")
        raise AuthError(503, "Scheduler sign-in not configured for /scan")

    idinfo = verify_google_id_token(token)

    if idinfo.get("aud") not in expected_auds:
        log.warning("Scan OIDC token audience %s not in allowlist", idinfo.get("aud"))
        raise AuthError(403, "Token audience not accepted for /scan")

    caller_email = idinfo.get("email", "")
    if caller_email != allowed_sa:
        log.warning("Scan OIDC caller %s does not match allowed SA %s", caller_email, allowed_sa)
        raise AuthError(403, "Service account not authorized for /scan")
    return caller_email


def verify_positions_api_token(token: str) -> str:
    """
    Verify an OIDC token for the service-to-service positions endpoint.
    Returns caller email on success. The caller must be on
    POSITIONS_API_ALLOWED_SAS and the audience must be this service
    (machine_api_audiences).
    """
    return _verify_machine_caller(token, "POSITIONS_API_ALLOWED_SAS", "Positions API")


def verify_households_api_token(token: str) -> str:
    """
    Verify an OIDC token for the service-to-service bulk households endpoint.
    Returns caller email on success.

    Reuses the machine-read allowlist (POSITIONS_API_ALLOWED_SAS): there is
    one service-to-service read surface, so one allowlist.
    """
    return _verify_machine_caller(token, "POSITIONS_API_ALLOWED_SAS", "Households API")


def verify_ops_portal_edit_token(token: str) -> str:
    """
    Verify an OIDC token for a service-account edit (the position, account,
    destination, Save to Drive and scan routes). Returns caller email on
    success.

    Edits have their own allowlist, OPS_PORTAL_EDIT_ALLOWED_SAS: a service
    allowed to read positions is not thereby allowed to change them.
    """
    return _verify_machine_caller(token, "OPS_PORTAL_EDIT_ALLOWED_SAS", "Service-account edits")


def load_user_or_raise(email: str) -> dict:
    """Look up a user by email in the allowlist. Raises AuthError on miss."""
    conn = pipeline_db.get_connection()
    try:
        user = pipeline_db.get_user_by_email(conn, email)
    finally:
        pipeline_db.put_connection(conn)
    if not user:
        raise AuthError(403, "User not authorized")
    return user


def extract_bearer_token(authorization_header: Optional[str]) -> Optional[str]:
    """Return the raw token from an `Authorization: Bearer …` header, or None."""
    if not authorization_header or not authorization_header.startswith("Bearer "):
        return None
    return authorization_header.removeprefix("Bearer ").strip()


# ---------------------------------------------------------------------------
# Long-lived MCP tokens (opaque, DB-stored)
# ---------------------------------------------------------------------------

def _hash_mcp_token(raw_token: str) -> str:
    """SHA-256 hex digest. Constant-time-comparison-safe via the hash equality."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def is_mcp_token(token: str) -> bool:
    """True iff the given bearer string looks like one of our MCP tokens."""
    return bool(token) and token.startswith(MCP_TOKEN_PREFIX)


def mint_mcp_token(
    *,
    user_email: str,
    description: str,
    ttl_days: Optional[int] = None,
    created_by: str,
) -> dict:
    """
    Generate a new MCP token, persist its hash, and return both the raw
    value (returned to the caller exactly once) and the metadata row.

    Verifies the user is in the allowlist before minting.
    """
    user = load_user_or_raise(user_email)  # raises if not allowlisted

    raw_body = secrets.token_urlsafe(MCP_TOKEN_BYTES)
    raw_token = f"{MCP_TOKEN_PREFIX}{raw_body}"
    token_hash = _hash_mcp_token(raw_token)
    last4 = raw_token[-4:]

    ttl = ttl_days if ttl_days and ttl_days > 0 else DEFAULT_MCP_TOKEN_TTL_DAYS
    expires_at = datetime.now(timezone.utc) + timedelta(days=ttl)

    conn = pipeline_db.get_connection()
    try:
        row = pipeline_db.insert_mcp_token(
            conn,
            token_hash=token_hash,
            user_email=user["email"],
            description=description,
            last4=last4,
            expires_at=expires_at,
            created_by=created_by,
        )
    finally:
        pipeline_db.put_connection(conn)

    # Return the raw token alongside the metadata. Callers must not log it.
    return {**row, "token": raw_token}


def verify_mcp_token(token: str) -> dict:
    """
    Look up an opaque MCP token, validate it (not revoked, not expired,
    user still in allowlist), update last_used_at, and return the user
    dict in the same shape as verify_web_user_token.

    Raises AuthError on any failure.
    """
    if not is_mcp_token(token):
        raise AuthError(401, "Not an MCP token")

    token_hash = _hash_mcp_token(token)
    conn = pipeline_db.get_connection()
    try:
        row = pipeline_db.lookup_mcp_token_by_hash(conn, token_hash)
        if not row:
            # Could be: not found, revoked, expired, OR the user was
            # removed from the allowlist (FK cascade deleted the token).
            # Don't leak which.
            raise AuthError(401, "MCP token invalid, expired, or revoked")
        try:
            pipeline_db.touch_mcp_token(conn, row["token_id"])
        except Exception as exc:  # touch is best-effort; never block the request
            log.warning("Failed to update last_used_at for MCP token: %s", exc)
    finally:
        pipeline_db.put_connection(conn)

    return {
        "id": row["user_id"],
        "email": row["email"],
        "role": row["role"],
        "created_at": row.get("user_created_at"),
        "google_name": "",
        "google_picture": "",
        # Surface the auth method so handlers can log/audit if they want
        "_auth_method": "mcp_token",
        "_mcp_token_id": row["token_id"],
    }


def verify_bearer_token(token: str) -> dict:
    """
    Verify any Authorization Bearer the MCP server might receive, in
    priority order:
        1. eg_mcp_…       — long-lived opaque token (DB-stored)
        2. eyJ…           — Google ID token (web user)
    Returns the resolved user dict. Raises AuthError on any failure.
    """
    if is_mcp_token(token):
        return verify_mcp_token(token)
    return verify_web_user_token(token)
