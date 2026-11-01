"""
The public demo's switches: demo mode, the two sign-in personas, their signed session cookie, and the routes
the demo refuses.

DEMO_MODE=on turns the demo on:
  * Persona sign-in replaces Google sign-in. A visitor picks Jordan Reyes (ops) or Rachel Moss (advisor); the
    server sets a signed, HttpOnly session cookie and every request is checked against the users table.
  * The scheduler, the machine APIs, MCP and the Drive scan answer 404 (PRIVATE_PATHS).
  * The Slack scan summary and "Save to Drive" are captured in the Outbox instead of leaving the app.

It is never on where APP_ENV=production, so a real deployment cannot be talked into persona sign-in.
Settings are read on every call, so tests can patch the environment.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time
from collections import defaultdict, deque
from typing import Optional
from urllib.parse import urlsplit

# The demo's personas (plan D7): staff from the shared synthetic universe, with the emails the other demos use.
PERSONAS = (
    {
        "key": "jordan-reyes", "name": "Jordan Reyes", "title": "Transfer specialist",
        "email": "jordan.reyes@example.com", "role": "ops",
    },
    {
        "key": "rachel-moss", "name": "Rachel Moss", "title": "Advisor",
        "email": "rachel.moss@example.com", "role": "advisor",
    },
)

SESSION_COOKIE = "stmt_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
_MIN_SECRET_CHARS = 32

# Refused with 404 in demo mode, before routing: the scheduler's routes, the Drive scan, the machine APIs, MCP
# and its tokens, and FastAPI's generated API docs (whose pages load their scripts from a CDN the demo's
# Content-Security-Policy refuses). A prefix ending in "/" matches everything under it; any other matches itself
# and its subpaths. The Worker refuses these, and the reset, at the edge (worker/src/rules.js; a test checks the
# two lists).
PRIVATE_PATHS = (
    "/scan",
    "/api/scan",
    "/api/schedule-status",
    "/api/destinations/backfill",
    "/api/staleness/backfill",
    "/api/v1/",
    "/api/mcp-tokens",
    "/mcp",
    "/docs",
    "/redoc",
    "/openapi.json",
)

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# The reset, called by the Worker's cron with a token rather than by a signed-in browser.
RESET_PATH = "/api/internal/demo-reset"

# Limits (plan §7). Whatever a visitor writes stays in the shared database until the nightly reset.
MAX_RUNS = 300                     # household runs between resets, the seed's included
MAX_USERS = 25
MAX_DESTINATIONS_PER_CLIENT = 12
MAX_OUTBOX = 500
MAX_BODY_BYTES = 128 * 1024
TEXT_LIMITS = {"notes": 500, "email": 254, "owner": 120, "existing_apex_number": 40, "account_type": 60,
               "account_type_other": 60}
# Per visitor, so one visitor can't use up what everyone shares. A sample run counts each household it runs.
SAMPLE_RUNS_PER_VISITOR = (20, 3600)  # at most 20 household runs in any hour
# PDFs are the costliest thing a visitor can ask for (the container has a quarter of a vCPU and ten database
# connections): a few at a time across all visitors, and a per-visitor allowance.
EXPORTS_PER_VISITOR = (20, 600)       # at most 20 PDFs (exports, Drive saves, sample statements) in 10 minutes
CONCURRENT_EXPORTS = 2
EXPORT_WAIT_SECONDS = 20


def demo_mode() -> bool:
    return os.getenv("DEMO_MODE", "") == "on" and os.getenv("APP_ENV", "") != "production"


def persona_by_key(key: object) -> Optional[dict]:
    return next((p for p in PERSONAS if p["key"] == key), None)


def persona_by_email(email: object) -> Optional[dict]:
    if not isinstance(email, str):
        return None
    canonical = email.strip().lower()
    return next((p for p in PERSONAS if p["email"] == canonical), None)


def is_private_path(path: str) -> bool:
    for prefix in PRIVATE_PATHS:
        if prefix.endswith("/"):
            if path.startswith(prefix):
                return True
        elif path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def is_unsafe_method(method: str) -> bool:
    return method.upper() in _UNSAFE_METHODS


def visitor_key(headers, client_host: Optional[str], email: str) -> str:
    """One visitor: the first X-Forwarded-For address (the Worker sets it per visitor), else the connecting host,
    with the persona they signed in as."""
    forwarded = (headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return f"{forwarded or client_host or 'unknown'}|{email}"


class RateLimiter:
    """At most *limit* events per key in any *window* seconds. In memory: the demo runs one container. Keys whose
    events have all expired are dropped, so a stream of new visitors can't grow it without bound."""

    _SWEEP_AT = 1024  # keys held before expired ones are swept

    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self._events: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, cost: int = 1, now: Optional[float] = None) -> bool:
        """Spend *cost* events for *key* if they fit in its window."""
        now = time.monotonic() if now is None else now
        with self._lock:
            if len(self._events) >= self._SWEEP_AT:
                for stale in [k for k, ev in self._events.items() if not ev or ev[-1] <= now - self.window]:
                    del self._events[stale]
            events = self._events[key]
            while events and events[0] <= now - self.window:
                events.popleft()
            if len(events) + cost > self.limit:
                if not events:
                    del self._events[key]
                return False
            events.extend([now] * cost)
            return True

    def refund(self, key: str, cost: int = 1) -> None:
        """Give back the last *cost* events for *key*, when the action they paid for was refused anyway."""
        with self._lock:
            events = self._events.get(key)
            for _ in range(min(cost, len(events) if events else 0)):
                events.pop()
            if events is not None and not events:
                del self._events[key]


def from_this_site(headers) -> bool:
    """The browser's own word that a request came from this site; the Origin header for one too old to send
    Sec-Fetch-Site. Cookie sign-in makes every state-changing request a cross-site forgery target, and
    SameSite=Lax does not cover sibling subdomains, so the demo refuses unsafe methods without it."""
    site = headers.get("sec-fetch-site")
    if site is not None:
        return site == "same-origin"
    origin, host = headers.get("origin"), headers.get("host")
    if not origin or not host:
        return False
    try:
        return urlsplit(origin).netloc == host
    except ValueError:
        return False


_SAFE_PATH = re.compile(r"^/(?![/\\])[A-Za-z0-9/_\-.]*$")


def safe_next(value: object, default: str = "/") -> str:
    """A same-origin path to return to after sign-in, or the default. Letters, digits and /_-. only, so no
    scheme, host, query, backslash or control character survives."""
    if isinstance(value, str) and len(value) <= 200 and _SAFE_PATH.match(value):
        return value
    return default


# ---------------------------------------------------------------------------
# Session cookie: "v1.<payload>.<HMAC-SHA256>", base64url, signed with SESSION_SECRET.
# The payload carries only the email and an expiry; the role is read from the users table on every request.
# ---------------------------------------------------------------------------

def _secret() -> Optional[bytes]:
    raw = os.getenv("SESSION_SECRET", "")
    return raw.encode("utf-8") if len(raw) >= _MIN_SECRET_CHARS else None


def session_configured() -> bool:
    return _secret() is not None


def cookie_secure() -> bool:
    """Secure unless SESSION_COOKIE_SECURE=off (plain-http local runs outside Chromium)."""
    return os.getenv("SESSION_COOKIE_SECURE", "") != "off"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(secret: bytes, body: str) -> str:
    return _b64(hmac.new(secret, f"v1.{body}".encode("ascii"), hashlib.sha256).digest())


def sign_session(email: str, now: Optional[float] = None) -> str:
    secret = _secret()
    if secret is None:
        raise RuntimeError(f"SESSION_SECRET must be set to at least {_MIN_SECRET_CHARS} characters")
    issued = time.time() if now is None else now
    claims = {"email": email, "exp": int(issued + SESSION_TTL_SECONDS)}
    body = _b64(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    return f"v1.{body}.{_mac(secret, body)}"


def verify_session(value: Optional[str], now: Optional[float] = None) -> Optional[str]:
    """The email in a valid, unexpired session cookie; None for anything else."""
    secret = _secret()
    if secret is None or not value or len(value) > 1024:
        return None
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return None
    body, signature = parts[1], parts[2]
    try:
        if not hmac.compare_digest(_mac(secret, body), signature):
            return None
        claims = json.loads(_unb64(body))
    except (ValueError, UnicodeError, TypeError):  # TypeError: compare_digest refuses non-ASCII text
        return None
    if not isinstance(claims, dict):
        return None
    email, expires = claims.get("email"), claims.get("exp")
    if not isinstance(email, str) or not isinstance(expires, int) or isinstance(expires, bool):
        return None
    if expires <= (time.time() if now is None else now):
        return None
    return email
