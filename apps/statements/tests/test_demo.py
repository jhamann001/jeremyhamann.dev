"""Demo mode: persona sign-in, the session cookie, refused routes, role checks, the persona fence and the Outbox."""
from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs
from uuid import uuid4

import psycopg2
import pytest
from fastapi.responses import Response
from fastapi.testclient import TestClient

import automation_pipeline as ap
import db
import demo
import server

SECRET = "s" * 40
OPS = demo.persona_by_key("jordan-reyes")
ADVISOR = demo.persona_by_key("rachel-moss")
SAME_ORIGIN = {"Sec-Fetch-Site": "same-origin"}


@pytest.fixture
def demo_env(monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "on")
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("SESSION_SECRET", SECRET)
    monkeypatch.delenv("SESSION_COOKIE_SECURE", raising=False)


@pytest.fixture
def client():
    # https, so the Secure session cookie is sent back the way a browser would. Not entered as a context
    # manager: no lifespan, so no DB pool.
    c = TestClient(server.app, base_url="https://testserver")
    yield c
    c.close()


def user_row(persona, role=None):
    return {"id": str(uuid4()), "email": persona["email"], "role": role or persona["role"]}


@contextmanager
def users(*rows):
    by_email = {r["email"]: r for r in rows}

    def load(email):
        if email not in by_email:
            raise server.pipeline_auth.AuthError(403, "User not authorized")
        return dict(by_email[email])
    with mock.patch.object(server.pipeline_auth, "load_user_or_raise", side_effect=load):
        yield


def signed_in(c, persona):
    c.cookies.set(demo.SESSION_COOKIE, demo.sign_session(persona["email"]))


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def test_demo_mode_needs_on_and_is_never_on_in_production(monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "on")
    monkeypatch.delenv("APP_ENV", raising=False)
    assert demo.demo_mode()
    monkeypatch.setenv("APP_ENV", "production")
    assert not demo.demo_mode()
    monkeypatch.delenv("APP_ENV")
    for value in ("", "1", "true", "ON"):
        monkeypatch.setenv("DEMO_MODE", value)
        assert not demo.demo_mode()


def test_session_round_trip_and_every_tamper_is_refused(demo_env):
    now = 1_800_000_000
    cookie = demo.sign_session(OPS["email"], now=now)
    assert demo.verify_session(cookie, now=now + 60) == OPS["email"]

    version, body, signature = cookie.split(".")
    other_body = demo._b64(b'{"email":"' + ADVISOR["email"].encode() + b'","exp":9999999999}')
    for forged in (
        f"{version}.{other_body}.{signature}",          # body swapped, old signature
        f"{version}.{body}.{signature[:-2]}AA",         # signature altered
        f"v2.{body}.{signature}",                       # unknown version
        f"{body}.{signature}",                          # missing part
        f"{version}.{body}.{signature}é",               # non-ASCII signature
        "",
        None,
        "x" * 2000,
    ):
        assert demo.verify_session(forged, now=now) is None
    assert demo.verify_session(cookie, now=now + demo.SESSION_TTL_SECONDS) is None  # expired


def test_session_needs_a_long_secret(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", SECRET)
    cookie = demo.sign_session(OPS["email"])
    monkeypatch.setenv("SESSION_SECRET", "short")
    assert not demo.session_configured()
    assert demo.verify_session(cookie) is None
    with pytest.raises(RuntimeError):
        demo.sign_session(OPS["email"])
    monkeypatch.setenv("SESSION_SECRET", "t" * 40)  # a different secret refuses the old cookie
    assert demo.verify_session(cookie) is None


def test_safe_next_keeps_only_same_origin_paths():
    run = f"/run/{uuid4()}"
    assert demo.safe_next("/") == "/"
    assert demo.safe_next(run) == run
    for unsafe in ("//evil.example", "/\\evil.example", "https://evil.example/", "/a?b=c", "/a#b",
                   "javascript:alert(1)", "", "a/b", "/a\nb", None, 7, "/" + "a" * 300):
        assert demo.safe_next(unsafe) == "/"


def test_private_paths():
    for path in ("/scan", "/api/scan", "/api/schedule-status", "/api/destinations/backfill",
                 "/api/staleness/backfill", "/api/v1/positions", "/api/v1/households", "/api/v1/x/y",
                 "/api/mcp-tokens", f"/api/mcp-tokens/{uuid4()}", "/mcp", "/mcp/",
                 "/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"):
        assert demo.is_private_path(path), path
    for path in ("/", "/api/households", "/api/me", "/api/users", "/api/outbox", "/scanner", "/mcpx",
                 "/auth/persona", "/assets/index.js", "/health", "/api/health", "/documents"):
        assert not demo.is_private_path(path), path


# ---------------------------------------------------------------------------
# Refused routes and cross-site requests
# ---------------------------------------------------------------------------

PRIVATE_REQUESTS = [
    ("POST", "/scan"), ("POST", "/api/scan"), ("GET", "/api/schedule-status"),
    ("POST", "/api/destinations/backfill"), ("POST", "/api/staleness/backfill"),
    ("GET", "/api/v1/positions?account_number=1"), ("GET", "/api/v1/position-accounts?q=ab"),
    ("POST", "/api/v1/holdings-transferability"), ("GET", "/api/v1/households"),
    ("GET", "/api/v1/clients/x/destinations"),
    ("GET", "/api/mcp-tokens"), ("POST", "/api/mcp-tokens"), ("DELETE", f"/api/mcp-tokens/{uuid4()}"),
    ("GET", "/mcp"), ("POST", "/mcp/"),
    ("GET", "/docs"), ("GET", "/redoc"), ("GET", "/openapi.json"),
]


def test_private_routes_answer_404_before_any_work(demo_env, client):
    signed_in(client, OPS)
    with users(user_row(OPS)), mock.patch.object(db, "get_connection") as connect, \
         mock.patch.object(server, "run_once") as scan:
        for method, path in PRIVATE_REQUESTS:
            response = client.request(method, path, headers={**SAME_ORIGIN, "Authorization": "Bearer x"})
            assert response.status_code == 404, (method, path)
    connect.assert_not_called()
    scan.assert_not_called()


@pytest.mark.parametrize("headers", [
    {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"},            # a sibling subdomain
    {"Sec-Fetch-Site": "none"},
    {},                                         # neither header
    {"Origin": "https://evil.example"},
])
def test_state_changing_requests_from_elsewhere_are_refused(demo_env, client, headers):
    signed_in(client, OPS)
    with users(user_row(OPS)), mock.patch.object(db, "get_connection") as connect:
        sign_in = client.post("/auth/persona", data={"persona": "jordan-reyes"}, headers=headers,
                              follow_redirects=False)
        edit = client.patch(f"/api/positions/{uuid4()}/status", json={"status": "ACAT"}, headers=headers)
        sign_out = client.post("/auth/sign-out", headers=headers, follow_redirects=False)
    assert (sign_in.status_code, edit.status_code, sign_out.status_code) == (403, 403, 403)
    assert demo.SESSION_COOKIE not in sign_in.headers.get("set-cookie", "")
    connect.assert_not_called()


def test_an_origin_header_naming_this_host_is_accepted_without_sec_fetch_site(demo_env, client):
    with users(user_row(OPS)):
        response = client.post("/auth/persona", data={"persona": "jordan-reyes"},
                               headers={"Origin": "https://testserver"}, follow_redirects=False)
    assert response.status_code == 303


# ---------------------------------------------------------------------------
# Sign-in and sign-out
# ---------------------------------------------------------------------------

def test_persona_sign_in_sets_a_signed_httponly_cookie_and_returns_to_a_relative_path(demo_env, client):
    run = f"/run/{uuid4()}"
    with users(user_row(OPS)):
        response = client.post("/auth/persona", data={"persona": "jordan-reyes", "next": run},
                               headers=SAME_ORIGIN, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == run          # relative: the browser keeps the caller's origin
    assert response.headers["cache-control"] == "no-store"
    set_cookie = response.headers["set-cookie"]
    for attribute in ("HttpOnly", "Secure", "SameSite=lax", "Path=/", f"Max-Age={demo.SESSION_TTL_SECONDS}"):
        assert attribute in set_cookie
    assert demo.verify_session(response.cookies[demo.SESSION_COOKIE]) == OPS["email"]


@pytest.mark.parametrize("form, code", [
    ({"persona": "nobody"}, "persona"),
    ({"persona": ""}, "persona"),
    ({}, "persona"),
    ({"persona": "jordan-reyes", "next": "//evil.example"}, None),  # unsafe next: lands on /
    ({"persona": "jordan-reyes", "a": "1", "b": "2", "c": "3", "d": "4"}, "persona"),  # more fields than the form
])
def test_persona_sign_in_refusals(demo_env, client, form, code):
    with users(user_row(OPS)):
        response = client.post("/auth/persona", data=form, headers=SAME_ORIGIN, follow_redirects=False)
    assert response.status_code == 303
    if code:
        assert response.headers["location"] == f"/?signin_error={code}"
        assert "set-cookie" not in response.headers
    else:
        assert response.headers["location"] == "/"


def test_persona_sign_in_fails_closed_on_configuration(demo_env, client, monkeypatch):
    with users(user_row(OPS, role="advisor")):  # the persona's row has drifted
        drifted = client.post("/auth/persona", data={"persona": "jordan-reyes"}, headers=SAME_ORIGIN,
                              follow_redirects=False)
    with users():                               # no row at all
        missing = client.post("/auth/persona", data={"persona": "jordan-reyes"}, headers=SAME_ORIGIN,
                              follow_redirects=False)
    monkeypatch.setenv("SESSION_SECRET", "short")
    with users(user_row(OPS)):
        no_secret = client.post("/auth/persona", data={"persona": "jordan-reyes"}, headers=SAME_ORIGIN,
                                follow_redirects=False)
    for response in (drifted, missing, no_secret):
        assert response.headers["location"] == "/?signin_error=config"
        assert "set-cookie" not in response.headers


def test_sign_out_clears_the_cookie(demo_env, client):
    signed_in(client, OPS)
    response = client.post("/auth/sign-out", headers=SAME_ORIGIN, follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"] == "/"
    assert f'{demo.SESSION_COOKIE}=""' in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_auth_routes_do_not_exist_outside_demo_mode(client, monkeypatch):
    monkeypatch.delenv("DEMO_MODE", raising=False)
    assert client.post("/auth/persona", data={"persona": "jordan-reyes"}, follow_redirects=False).status_code == 404
    assert client.post("/auth/sign-out", follow_redirects=False).status_code == 404


def test_config_lists_the_personas_without_their_emails(demo_env, client):
    body = client.get("/api/config").json()
    assert body["demo"] is True and body["google_client_id"] == ""
    assert [p["key"] for p in body["personas"]] == ["jordan-reyes", "rachel-moss"]
    assert all(set(p) == {"key", "name", "title", "role"} for p in body["personas"])


# ---------------------------------------------------------------------------
# Who sees what
# ---------------------------------------------------------------------------

def test_me_reads_the_cookie_and_ignores_bearer_tokens(demo_env, client):
    ops = {"email": "someone@example.invalid", "role": "ops"}
    with users(user_row(OPS)), \
         mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value=ops) as google:
        anonymous = client.get("/api/me", headers={"Authorization": "Bearer synthetic-token"})
        client.cookies.set(demo.SESSION_COOKIE, "v1.forged.cookie")
        forged = client.get("/api/me")
        signed_in(client, OPS)
        me = client.get("/api/me")
    assert (anonymous.status_code, forged.status_code) == (401, 401)
    assert me.json() == {"email": OPS["email"], "role": "ops", "name": "Jordan Reyes", "picture": ""}
    google.assert_not_called()


def test_a_removed_user_is_refused_even_with_a_valid_cookie(demo_env, client):
    signed_in(client, OPS)
    with users():
        assert client.get("/api/me").status_code == 403


@contextmanager
def edits():
    with mock.patch.object(db, "get_connection", return_value=object()) as connect, \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "update_position_override", return_value=True) as override, \
         mock.patch.object(db, "get_households", return_value=[]) as households:
        yield SimpleNamespace(connect=connect, override=override, households=households)


def test_the_advisor_reads_but_cannot_edit(demo_env, client):
    signed_in(client, ADVISOR)
    with users(user_row(ADVISOR)), edits() as e:
        read = client.get("/api/households")
        edit = client.patch(f"/api/positions/{uuid4()}/status", json={"status": "ACAT"}, headers=SAME_ORIGIN)
        admin = client.get("/api/users")
        outbox = client.get("/api/outbox")
    assert (read.status_code, edit.status_code, admin.status_code, outbox.status_code) == (200, 403, 403, 403)
    e.override.assert_not_called()


def test_ops_edits_and_is_recorded_as_the_actor(demo_env, client):
    signed_in(client, OPS)
    with users(user_row(OPS)), edits() as e:
        response = client.patch(f"/api/positions/{uuid4()}/status", json={"status": "LIQUIDATE", "notes": "n"},
                                headers=SAME_ORIGIN)
    assert response.status_code == 200
    assert e.override.call_args.args[4] == OPS["email"]


def test_service_accounts_cannot_edit_in_demo_mode(demo_env, client):
    sa = "ops-portal-run@synthetic-project.iam.gserviceaccount.com"
    with mock.patch.object(server.pipeline_auth, "verify_web_user_token",
                           side_effect=server.pipeline_auth.AuthError(401, "nope")), \
         mock.patch.object(server.pipeline_auth, "verify_ops_portal_edit_token", return_value=sa) as edit_sa, \
         mock.patch.object(server.pipeline_auth, "verify_households_api_token", return_value=sa) as read_sa, \
         edits() as e:
        headers = {**SAME_ORIGIN, "Authorization": "Bearer synthetic-token"}
        edit = client.patch(f"/api/positions/{uuid4()}/status", json={"status": "ACAT"}, headers=headers)
        pdf = client.get("/api/households/export/pdf", headers=headers)
    assert (edit.status_code, pdf.status_code) == (401, 401)
    edit_sa.assert_not_called()
    read_sa.assert_not_called()
    e.override.assert_not_called()


# ---------------------------------------------------------------------------
# Persona fence
# ---------------------------------------------------------------------------

def test_personas_cannot_be_demoted_or_removed(demo_env, client):
    signed_in(client, OPS)
    persona_id, other_id = str(uuid4()), str(uuid4())
    rows = {persona_id: {"id": persona_id, "email": ADVISOR["email"], "role": "advisor"},
            other_id: {"id": other_id, "email": "added@example.invalid", "role": "advisor"}}
    with users(user_row(OPS)), \
         mock.patch.object(db, "get_connection", return_value=object()), \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "get_user_by_id", side_effect=lambda conn, uid: rows.get(uid)), \
         mock.patch.object(db, "update_user_role", return_value=rows[other_id]) as update, \
         mock.patch.object(db, "delete_user", return_value=True) as delete:
        promote = client.patch(f"/api/users/{persona_id}", json={"role": "ops"}, headers=SAME_ORIGIN)
        remove = client.delete(f"/api/users/{persona_id}", headers=SAME_ORIGIN)
        other_promote = client.patch(f"/api/users/{other_id}", json={"role": "ops"}, headers=SAME_ORIGIN)
        other_remove = client.delete(f"/api/users/{other_id}", headers=SAME_ORIGIN)
    assert (promote.status_code, remove.status_code) == (403, 403)
    assert (other_promote.status_code, other_remove.status_code) == (200, 200)
    assert update.call_count == 1 and delete.call_count == 1


# ---------------------------------------------------------------------------
# Outbox
# ---------------------------------------------------------------------------

def test_save_to_drive_is_captured_in_the_outbox(demo_env, client):
    hid = str(uuid4())
    signed_in(client, OPS)
    household = {"id": hid, "client_name": "Kofi Okafor", "accounts": []}
    conn = mock.MagicMock()
    with users(user_row(OPS)), \
         mock.patch.object(db, "get_connection", return_value=conn), \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "get_household_detail", return_value=household), \
         mock.patch.object(server, "generate_household_pdf", return_value=b"%PDF" + b"0" * 4096), \
         mock.patch.object(db, "insert_outbox_entry", return_value="entry-1") as outbox, \
         mock.patch.object(db, "mark_household_reviewed", return_value=datetime(2026, 10, 29, 9, 0)) as reviewed, \
         mock.patch.object(server, "build_google_services") as drive:
        response = client.post(f"/api/households/{hid}/save-to-drive", headers=SAME_ORIGIN)
    assert response.status_code == 200
    body = response.json()
    assert body["file_id"] == "entry-1" and body["web_view_link"] == "" and body["reviewed_by"] == OPS["email"]
    kwargs = outbox.call_args.kwargs
    assert kwargs["kind"] == "drive" and kwargs["created_by"] == OPS["email"] and kwargs["commit"] is False
    assert kwargs["keep"] == demo.MAX_OUTBOX  # a full Outbox drops its oldest entries rather than refusing
    conn.commit.assert_called()  # the entry and the reviewed stamp are committed together
    assert kwargs["meta"]["folder"] == "Kofi Okafor" and kwargs["meta"]["filename"] == body["filename"]
    assert reviewed.call_args.args[1:] == (hid, OPS["email"])
    drive.assert_not_called()


def test_the_scan_summary_is_captured_in_the_outbox_and_never_posted(demo_env, monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example.invalid/synthetic")
    results = [{"status": "success", "client": "Kofi Okafor", "household_id": "h1"},
               {"status": "error", "client": "Ken Nakamura", "error": "Statement is stale"}]
    with mock.patch.object(db, "get_connection", return_value=object()), \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "insert_outbox_entry", return_value="entry-2") as outbox, \
         mock.patch.object(ap.requests, "post") as post:
        ap.send_slack_notification(results)
    post.assert_not_called()
    kwargs = outbox.call_args.kwargs
    assert kwargs["kind"] == "slack" and kwargs["title"] == "Statement Pipeline — Scan Complete"
    assert "Kofi Okafor" in kwargs["body"] and "Statement is stale" in kwargs["body"]


def test_outside_demo_mode_the_scan_summary_is_posted(monkeypatch):
    monkeypatch.delenv("DEMO_MODE", raising=False)
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example.invalid/synthetic")
    with mock.patch.object(db, "insert_outbox_entry") as outbox, mock.patch.object(ap.requests, "post") as post:
        ap.send_slack_notification([{"status": "success", "client": "A", "household_id": "h"}])
    post.assert_called_once()
    outbox.assert_not_called()


def test_outbox_lists_for_ops_and_is_absent_outside_demo_mode(demo_env, client, monkeypatch):
    signed_in(client, OPS)
    entries = [{"id": "e1", "kind": "slack", "title": "t", "body": "b", "meta": {}, "created_by": None,
                "created_at": "2026-10-29T09:00:00-04:00"}]
    with users(user_row(OPS)), \
         mock.patch.object(db, "get_connection", return_value=object()), \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "list_outbox", return_value=entries) as listing:
        listed = client.get("/api/outbox")
        monkeypatch.delenv("DEMO_MODE")
        with mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value={"role": "ops"}):
            absent = client.get("/api/outbox", headers={"Authorization": "Bearer synthetic-token"})
    assert listed.status_code == 200 and listed.json() == entries
    assert listing.call_args.kwargs["limit"] == server.OUTBOX_LIMIT
    assert absent.status_code == 404


# ---------------------------------------------------------------------------
# Sample statements
# ---------------------------------------------------------------------------

def test_samples_list_for_ops_only_and_only_in_demo_mode(demo_env, client, monkeypatch):
    signed_in(client, OPS)
    with users(user_row(OPS)):
        listed = client.get("/api/samples")
    assert listed.status_code == 200
    assert [s["key"] for s in listed.json()] == [s.key for s in server.SAMPLES]
    assert set(listed.json()[0]) == {"key", "client_name", "custodian", "shows", "documents", "screened_out"}
    alvarez = next(s for s in listed.json() if s["key"] == "alvarez")
    assert alvarez["screened_out"] == ["Alvarez_SchwabBank_Checking_2026-09.pdf"]
    signed_in(client, ADVISOR)
    with users(user_row(ADVISOR)):
        assert client.get("/api/samples").status_code == 403
    monkeypatch.delenv("DEMO_MODE")
    with mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value={"role": "ops"}):
        assert client.get("/api/samples", headers={"Authorization": "Bearer synthetic-token"}).status_code == 404


def test_running_samples_validates_locks_and_runs_them_in_order(demo_env, client):
    signed_in(client, OPS)
    results = [{"client": "Okafor Household", "sample": "okafor", "status": "success", "household_id": "h1"}]
    with users(user_row(OPS)), \
         mock.patch.object(db, "get_connection", return_value=object()) as connect, \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "count_households", return_value=0), \
         mock.patch.object(server.stand_ins, "run_samples", return_value=results) as run:
        bad = [client.post("/api/samples/run", json={"keys": keys}, headers=SAME_ORIGIN).status_code
               for keys in ([], ["nobody"], ["okafor", "../etc"])]
        ok = client.post("/api/samples/run", json={"keys": ["okafor", "rossi", "okafor"]}, headers=SAME_ORIGIN)
        assert server._scan_lock.acquire(blocking=False)
        try:
            busy = client.post("/api/samples/run", json={"keys": ["okafor"]}, headers=SAME_ORIGIN)
        finally:
            server._scan_lock.release()
        cross_site = client.post("/api/samples/run", json={"keys": ["okafor"]},
                                 headers={"Sec-Fetch-Site": "cross-site"})
    assert bad == [400, 400, 400]
    assert ok.status_code == 200 and ok.json()["clients_processed"] == 1
    assert run.call_count == 1 and run.call_args.args == (["okafor", "rossi"], connect.return_value)
    assert (busy.status_code, cross_site.status_code) == (409, 403)
    assert server._scan_lock.acquire(blocking=False)
    server._scan_lock.release()


def test_the_advisor_cannot_run_samples(demo_env, client):
    signed_in(client, ADVISOR)
    with users(user_row(ADVISOR)), mock.patch.object(server.stand_ins, "run_samples") as run:
        assert client.post("/api/samples/run", json={"keys": ["okafor"]}, headers=SAME_ORIGIN).status_code == 403
    run.assert_not_called()


def test_sample_pdfs_open_inline_with_the_demos_dates(demo_env, client):
    signed_in(client, ADVISOR)
    with users(user_row(ADVISOR)), mock.patch.object(server.stand_ins, "replay_shift_days", return_value=7):
        pdf = client.get("/api/samples/lindqvist/documents/Lindqvist_Fidelity_2026-09.pdf")
        wrong_doc = client.get("/api/samples/lindqvist/documents/Okafor_EdwardJones_2026-09.pdf")
        wrong_sample = client.get("/api/samples/nobody/documents/x.pdf")
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"].startswith("inline;")
    import zlib, re
    text = b"".join(zlib.decompress(m.group(1)) for m in re.finditer(rb"stream\n(.*?)\nendstream", pdf.content, re.S))
    assert b"10/07/2026" in text and b"09/30/2026" not in text
    assert (wrong_doc.status_code, wrong_sample.status_code) == (404, 404)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def test_demo_health_needs_only_the_database_and_session_secret(demo_env, client, monkeypatch):
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_NAME", "synthetic")
    fake = mock.MagicMock()
    with mock.patch.object(db, "get_connection", return_value=fake), mock.patch.object(db, "put_connection"):
        healthy = client.get("/health")
        monkeypatch.setenv("SESSION_SECRET", "short")
        short = client.get("/health")
        monkeypatch.delenv("SESSION_SECRET")
        missing = client.get("/health")
    assert healthy.status_code == 200
    assert short.status_code == 503 and missing.status_code == 503
    # What's missing goes to the log; a visitor sees only that the demo is down.
    assert missing.json() == {"detail": server.DEMO_SERVER_ERROR}


def test_server_errors_reach_visitors_as_a_plain_sentence(demo_env, client):
    """A 500's detail can hold the SQL and its values, or the database host; the demo answers without them."""
    signed_in(client, OPS)
    with users(user_row(OPS)), \
         mock.patch.object(db, "get_connection", return_value=mock.MagicMock()), \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "get_household_detail",
                           side_effect=psycopg2.errors.InvalidTextRepresentation(
                               'invalid input syntax for type uuid: "x" LINE 1: SELECT * FROM households')):
        response = client.get("/api/households/x")
    assert response.status_code == 500
    assert response.json() == {"detail": server.DEMO_SERVER_ERROR}


def test_a_busy_pool_answers_503(demo_env, client):
    signed_in(client, OPS)
    with users(user_row(OPS)), mock.patch.object(db, "get_connection", side_effect=db.PoolBusy("all in use")):
        response = client.get("/api/households")
    assert response.status_code == 503


def test_health_also_answers_at_api_health(demo_env, client, monkeypatch):
    """The Worker's start check, the deploy's live check and the portfolio site's warm-up call /api/health."""
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_NAME", "synthetic")
    with mock.patch.object(db, "get_connection", return_value=mock.MagicMock()), \
         mock.patch.object(db, "put_connection"):
        response = client.get("/api/health")
    assert response.status_code == 200 and response.json() == {"status": "healthy"}


# ---------------------------------------------------------------------------
# Database: personas, user lookup and the Outbox table (disposable Postgres only)
# ---------------------------------------------------------------------------

def connect(env):
    kwargs = {k[3:].lower(): v for k, v in env.items() if k.startswith("DB_")}
    return psycopg2.connect(host=kwargs["host"], port=kwargs["port"], dbname=kwargs["name"], user=kwargs["user"],
                            password=kwargs["password"], options=f"-c search_path={kwargs['search_path']}")


def test_personas_upsert_is_idempotent_and_restores_roles(pg):
    name = pg["schema"]()
    conn = connect(pg["env"]("DB_", name))
    try:
        db.upsert_personas(conn, demo.PERSONAS)
        pg["execute"](name, "UPDATE users SET role = 'ops' WHERE email = %s", (ADVISOR["email"],))
        db.upsert_personas(conn, demo.PERSONAS)
        rows = dict(pg["fetch"](name, "SELECT email, role FROM users ORDER BY email"))
        assert rows == {OPS["email"]: "ops", ADVISOR["email"]: "advisor"}
        advisor_id = pg["fetch"](name, f"SELECT id FROM users WHERE email = '{ADVISOR['email']}'")[0][0]
        assert db.get_user_by_id(conn, str(advisor_id))["email"] == ADVISOR["email"]
        assert db.get_user_by_id(conn, "not-a-uuid") is None
        assert db.get_user_by_id(conn, str(uuid4())) is None
    finally:
        conn.close()


def test_outbox_entries_list_newest_first(pg):
    name = pg["schema"]()
    conn = connect(pg["env"]("DB_", name))
    try:
        first = db.insert_outbox_entry(conn, kind="slack", title="one", body="b1", meta={"n": 1}, created_by=None)
        pg["execute"](name, "UPDATE outbox SET created_at = created_at - interval '1 minute' WHERE id = %s",
                      (first,))
        second = db.insert_outbox_entry(conn, kind="drive", title="two", body="b2", meta={"n": 2},
                                        created_by=OPS["email"])
        listed = db.list_outbox(conn, limit=10)
        assert [e["id"] for e in listed] == [second, first]
        assert listed[0]["meta"] == {"n": 2} and listed[0]["created_by"] == OPS["email"]
        assert len(db.list_outbox(conn, limit=1)) == 1
        with pytest.raises(psycopg2.errors.CheckViolation):
            db.insert_outbox_entry(conn, kind="email", title="x", body="x", meta={}, created_by=None)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Limits a single visitor can't exhaust for everyone (S11)
# ---------------------------------------------------------------------------

def test_the_rate_limiter_charges_a_cost_refunds_it_and_forgets_idle_visitors():
    limiter = demo.RateLimiter(10, 60)
    assert limiter.allow("a", cost=9, now=0)
    assert not limiter.allow("a", cost=2, now=1)  # 9 + 2 > 10
    limiter.refund("a", cost=9)
    assert limiter.allow("a", cost=10, now=2)
    assert limiter.allow("a", cost=10, now=63)  # the window has passed
    limiter._SWEEP_AT = 3
    for key in ("b", "c", "d"):
        assert limiter.allow(key, now=100)
    assert limiter.allow("e", now=200)  # b, c and d have expired: swept
    assert set(limiter._events) == {"e"}


def test_sample_runs_count_each_household_and_refund_a_refusal_that_is_not_the_visitor(demo_env, client, monkeypatch):
    monkeypatch.setattr(server, "_sample_runs", demo.RateLimiter(10, 3600))
    signed_in(client, OPS)
    nine = [s.key for s in server.SAMPLES][:9]
    assert len(nine) == 9
    run = lambda keys: client.post("/api/samples/run", json={"keys": keys}, headers=SAME_ORIGIN).status_code
    with users(user_row(OPS)), \
         mock.patch.object(db, "get_connection", return_value=object()), \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "count_households", return_value=0), \
         mock.patch.object(server.stand_ins, "run_samples", return_value=[]):
        server._scan_lock.acquire()
        try:
            assert run(nine) == 409  # someone else's run: not charged
        finally:
            server._scan_lock.release()
        assert run(nine) == 200
        assert run(nine[:2]) == 429  # 9 + 2 households > 10


def test_pdfs_have_a_per_visitor_allowance(demo_env, client, monkeypatch):
    monkeypatch.setattr(server, "_exports", demo.RateLimiter(2, 600))
    signed_in(client, ADVISOR)
    with users(user_row(ADVISOR)), mock.patch.object(server, "_household_pdf", return_value=Response(b"%PDF")):
        codes = [client.get(f"/api/households/{uuid4()}/pdf").status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_the_outbox_drops_its_oldest_entries_when_full(pg):
    name = pg["schema"]()
    conn = connect(pg["env"]("DB_", name))
    try:
        ids = [db.insert_outbox_entry(conn, kind="slack", title=f"t{i}", body="b", meta={}, created_by=None, keep=3)
               for i in range(5)]
        kept = [str(r[0]) for r in pg["fetch"](name, "SELECT id FROM outbox ORDER BY created_at, title")]
        assert sorted(kept) == sorted(ids[2:])
    finally:
        conn.close()


def test_a_cap_lock_holds_until_the_transaction_ends(pg):
    name = pg["schema"]()
    first, second = connect(pg["env"]("DB_", name)), connect(pg["env"]("DB_", name))
    try:
        db.lock_cap(first, "users")
        with second.cursor() as cur:
            cur.execute("SET lock_timeout = '200ms'")
        with pytest.raises(psycopg2.errors.LockNotAvailable):
            db.lock_cap(second, "users")
        second.rollback()
        first.commit()  # the insert's commit releases it
        db.lock_cap(second, "users")
        second.rollback()
    finally:
        first.close()
        second.close()


def test_a_full_pool_waits_then_answers_busy_and_a_dead_connection_is_replaced(monkeypatch):
    class Conn:
        def __init__(self, dead=False):
            self.dead = dead

        def cursor(self):
            conn = self

            class Cur:
                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return False

                def execute(self, _):
                    if conn.dead:
                        raise psycopg2.OperationalError("server closed the connection unexpectedly")
            return Cur()

        def rollback(self):
            pass

    class Pool:
        def __init__(self):
            self.handed = [Conn(dead=True), Conn()]
            self.closed = []

        def getconn(self):
            return self.handed.pop(0)

        def putconn(self, conn, close=False):
            if close:
                self.closed.append(conn)

    pool = Pool()
    monkeypatch.setattr(db, "_pool", pool)
    monkeypatch.setattr(db, "_pool_slots", __import__("threading").BoundedSemaphore(1))
    monkeypatch.setattr(db, "POOL_WAIT_SECONDS", 0.05)
    conn = db.get_connection()
    assert not conn.dead and len(pool.closed) == 1  # the dead one was closed and replaced
    with pytest.raises(db.PoolBusy):
        db.get_connection()  # the only slot is out
    db.put_connection(conn)
    pool.handed.append(Conn())
    db.put_connection(db.get_connection())  # the slot came back


def test_the_worker_refuses_every_private_path_and_shares_the_body_cap():
    """The Worker (worker/src/rules.js) and this app each keep a list of private paths and a body cap. The Worker
    may refuse more (the reset, which the app guards with its token), never less."""
    import re
    from pathlib import Path

    rules = (Path(__file__).resolve().parents[1] / "worker" / "src" / "rules.js").read_text(encoding="utf-8")
    worker_paths = re.compile(re.search(r"export const PRIVATE_PATHS =\s*/(.+)/;", rules).group(1))
    for prefix in demo.PRIVATE_PATHS:
        for path in (prefix.rstrip("/"), prefix.rstrip("/") + "/x"):
            if demo.is_private_path(path):
                assert worker_paths.search(path), path
    factors = re.search(r"export const MAX_BODY_BYTES = ([\d\s*]+);", rules).group(1).split("*")
    worker_cap = 1
    for factor in factors:
        worker_cap *= int(factor)
    assert worker_cap == demo.MAX_BODY_BYTES


def test_the_household_list_serves_the_sidebar_a_full_page():
    """The sidebar loads every run in one page of 500; the demo never holds more than its run cap."""
    assert server.MAX_HOUSEHOLDS_PER_PAGE >= 500 >= demo.MAX_RUNS
