"""The demo's seed and nightly reset (demo_reset.py), its route, and the demo's limits."""
from datetime import datetime, timedelta
from unittest import mock
from uuid import uuid4
from zoneinfo import ZoneInfo

import psycopg2
import pytest
from fastapi.testclient import TestClient

import automation_pipeline as ap
import db
import demo
import demo_reset
import server
import stand_ins
from tests.test_demo import ADVISOR, OPS, SAME_ORIGIN, SECRET, signed_in, user_row, users

ET = ZoneInfo("America/New_York")
NOW = datetime(2026, 11, 4, 3, 0, tzinfo=ET)   # a Wednesday, at the 07:00 UTC reset


# ---------------------------------------------------------------------------
# Pure pieces
# ---------------------------------------------------------------------------

def test_business_days_skip_weekends():
    monday = datetime(2026, 11, 2, 3, 0, tzinfo=ET)
    assert demo_reset.business_day_before(monday, 1).date().isoformat() == "2026-10-30"   # Friday
    assert demo_reset.business_day_before(monday, 5, 90) == datetime(2026, 10, 26, 10, 30, tzinfo=ET)


def test_direct_url_drops_the_pooler_only():
    pooled = "postgresql://u:p@ep-quiet-lake-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
    assert demo_reset.direct_url(pooled) == pooled.replace("-pooler.", ".")
    for other in ("postgresql:///local?host=/tmp", "postgresql://u@localhost:5432/x"):
        assert demo_reset.direct_url(other) == other


def test_the_plan_runs_oldest_first_on_weekdays_in_office_hours():
    plan = demo_reset.seed_plan(demo_reset.load_universe(), NOW)
    assert len(plan) == 48
    assert [r.processed_at for r in plan] == sorted(r.processed_at for r in plan)
    for run in plan:
        local = run.processed_at.astimezone(ET)
        assert local < NOW and local.weekday() < 5 and 9 <= local.hour < 17, run.sample.key
    folders = [r.folder_id for r in plan]
    assert folders.count("sample-okafor") == 2 and len(set(folders)) == 39


def test_roster_owners_match_how_statements_print_them():
    universe = demo_reset.load_universe()
    rows = {(r[1], r[4]) for r in demo_reset.roster_rows(universe)}
    assert ("Kofi Okafor, Ada Okafor", "JOINT") in rows
    assert ("Erik Lindqvist", "INDIVIDUAL") in rows


# ---------------------------------------------------------------------------
# The reset on disposable Postgres
# ---------------------------------------------------------------------------

def connect(env):
    kwargs = {k[3:].lower(): v for k, v in env.items() if k.startswith("DB_")}
    return psycopg2.connect(host=kwargs["host"], port=kwargs["port"], dbname=kwargs["name"], user=kwargs["user"],
                            password=kwargs["password"], options=f"-c search_path={kwargs['search_path']}")


@pytest.fixture
def seeded(pg, monkeypatch):
    monkeypatch.delenv("DEMO_MODE", raising=False)
    conn = connect(pg["env"]("DB_", pg["schema"]()))
    try:
        summary = demo_reset.reset_demo(conn, now=NOW)
        yield conn, summary
    finally:
        conn.close()


def _one(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def test_the_seed(seeded):
    conn, summary = seeded
    assert {k: summary[k] for k in ("runs", "households", "roster", "edits")} == \
        {"runs": 48, "households": 39, "roster": 93, "edits": 7}
    assert _one(conn, "SELECT array_agg(email ORDER BY email) FROM users")[0] == [OPS["email"], ADVISOR["email"]]
    assert _one(conn, "SELECT COUNT(*) FROM outbox")[0] == 0
    okafor = _one(conn, "SELECT id, run_number FROM households WHERE source_folder_id = 'sample-okafor' "
                        "AND superseded_by IS NULL")
    assert okafor[1] == 2
    detail = db.get_household_detail(conn, str(okafor[0]))
    bridge = next(p for a in detail["accounts"] for p in a["assets"] if p["symbol"] == "BBGLX")
    assert (bridge["effective_status"], bridge["overridden_by"]) == ("LIQUIDATE", OPS["email"])
    assert all(not a["is_stale"] for a in detail["accounts"])
    assert _one(conn, "SELECT COUNT(*) FROM positions WHERE deleted_by = %s", (OPS["email"],))[0] == 1
    assert _one(conn, "SELECT COUNT(*) FROM households WHERE reviewed_by = %s", (OPS["email"],))[0] == 4
    # The roster finds most destinations already open at the receiving custodian.
    assert _one(conn, "SELECT COUNT(*) FILTER (WHERE needs_to_be_opened) < COUNT(*) / 4 FROM target_accounts")[0]
    # Every timestamp the visitor sees is in the past.
    assert _one(conn, "SELECT MAX(processed_at) < %s, MAX(reviewed_at) < %s, MAX(overridden_at) < %s "
                      "FROM households, positions", (NOW, NOW, NOW)) == (True, True, True)


def test_the_reset_clears_what_visitors_added(seeded):
    conn, first = seeded
    db.create_user(conn, "visitor@example.invalid", "ops")
    db.insert_outbox_entry(conn, kind="slack", title="t", body="b", meta={}, created_by=None)
    stand_ins.run_samples(["okafor"], conn)
    assert _one(conn, "SELECT MAX(run_number) FROM households WHERE source_folder_id = 'sample-okafor'")[0] == 3

    again = demo_reset.reset_demo(conn, now=NOW)
    assert {k: again[k] for k in ("runs", "households", "positions")} == \
        {k: first[k] for k in ("runs", "households", "positions")}
    assert _one(conn, "SELECT COUNT(*) FROM users")[0] == 2
    assert _one(conn, "SELECT COUNT(*) FROM outbox")[0] == 0
    assert _one(conn, "SELECT MAX(run_number) FROM households WHERE source_folder_id = 'sample-okafor'")[0] == 2


def test_every_run_keeps_the_id_the_other_demos_link_to(seeded):
    conn, _ = seeded

    def runs():
        with conn.cursor() as cur:
            cur.execute("SELECT id::text, source_folder_id, run_number FROM households ORDER BY 1")
            return cur.fetchall()
    first = runs()
    assert len(first) == 48
    assert all(i == demo_reset.demo_run_id(folder, n) for i, folder, n in first)
    # Okafor's latest run, as the advisor platform's demo stores it (its seed derives the same id).
    assert ("f5d084fb-f428-4bcb-a1f5-b68a6fd6863c", "sample-okafor", 2) in first
    demo_reset.reset_demo(conn, now=NOW)
    assert runs() == first


@pytest.mark.parametrize("fail_at", ["pipeline", "edits"])
def test_a_failed_reset_keeps_yesterdays_data(seeded, monkeypatch, fail_at):
    conn, _ = seeded
    before = _one(conn, "SELECT array_agg(id ORDER BY id) FROM households")[0]
    db.create_user(conn, "visitor@example.invalid", "ops")
    if fail_at == "pipeline":
        calls = {"n": 0}
        real = ap.process_client_folder

        def flaky(**kwargs):
            calls["n"] += 1
            if calls["n"] == 20:
                raise RuntimeError("synthetic failure halfway through the seed")
            return real(**kwargs)
        monkeypatch.setattr(ap, "process_client_folder", flaky)
    else:
        monkeypatch.setattr(demo_reset, "_review_edits", mock.Mock(side_effect=RuntimeError("synthetic")))

    with pytest.raises(RuntimeError):
        demo_reset.reset_demo(conn, now=NOW)
    assert _one(conn, "SELECT array_agg(id ORDER BY id) FROM households")[0] == before
    assert _one(conn, "SELECT COUNT(*) FROM users WHERE email = 'visitor@example.invalid'")[0] == 1
    assert ap._genai_client is None


def test_a_step_that_rolls_back_aborts_the_whole_reset(seeded, monkeypatch):
    conn, _ = seeded
    before = _one(conn, "SELECT COUNT(*) FROM households")[0]
    real = db.supersede_previous_runs

    def rolls_back(conn_, *args):
        conn_.rollback()
        return real(conn_, *args)
    monkeypatch.setattr(db, "supersede_previous_runs", rolls_back)
    with pytest.raises(demo_reset.ResetAborted):
        demo_reset.reset_demo(conn, now=NOW)
    assert _one(conn, "SELECT COUNT(*) FROM households")[0] == before


@pytest.mark.parametrize("failure", ["error", "swallowed rollback"])
def test_a_failed_destination_seed_aborts_the_reset(seeded, monkeypatch, failure):
    """The pipeline only logs a failure while seeding a client's destinations; the reset must not commit a seed
    with clients that have none."""
    conn, _ = seeded
    before = _one(conn, "SELECT COUNT(*) FROM target_accounts")[0]
    real = ap._seed_destination_accounts
    calls = {"n": 0}

    def fails_once(db_conn, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 5:
            if failure == "error":
                raise ValueError("synthetic failure seeding destinations")
            db_conn.rollback()  # raises ResetAborted, which the pipeline's own handler swallows
        return real(db_conn, *args, **kwargs)
    monkeypatch.setattr(ap, "_seed_destination_accounts", fails_once)
    with pytest.raises(demo_reset.ResetAborted):
        demo_reset.reset_demo(conn, now=NOW)
    assert _one(conn, "SELECT COUNT(*) FROM target_accounts")[0] == before


# ---------------------------------------------------------------------------
# The reset route
# ---------------------------------------------------------------------------

@pytest.fixture
def demo_client(monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "on")
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("SESSION_SECRET", SECRET)
    monkeypatch.setenv("DEMO_RESET_TOKEN", "synthetic-reset-token")
    c = TestClient(server.app, base_url="https://testserver")
    yield c
    c.close()


def test_the_reset_route_needs_its_token(demo_client, monkeypatch):
    summary = {"runs": 48, "households": 39}
    with mock.patch.object(db, "get_connection", return_value=object()) as connect_, \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(demo_reset, "reset_demo", return_value=summary) as reset:
        wrong = demo_client.post(demo.RESET_PATH, headers={"Authorization": "Bearer wrong"})
        missing = demo_client.post(demo.RESET_PATH)
        # The Worker's cron sends no Sec-Fetch-Site or Origin: the token, not the same-origin rule, guards it.
        right = demo_client.post(demo.RESET_PATH, headers={"Authorization": "Bearer synthetic-reset-token"})
        monkeypatch.delenv("DEMO_RESET_TOKEN")
        unset = demo_client.post(demo.RESET_PATH, headers={"Authorization": "Bearer synthetic-reset-token"})
        monkeypatch.delenv("DEMO_MODE")
        off = demo_client.post(demo.RESET_PATH, headers={"Authorization": "Bearer synthetic-reset-token"})
    assert (wrong.status_code, missing.status_code, unset.status_code, off.status_code) == (401, 401, 503, 404)
    assert right.status_code == 200 and right.json() == summary
    reset.assert_called_once_with(connect_.return_value)


def test_the_reset_waits_for_a_run_in_progress(demo_client, monkeypatch):
    monkeypatch.setattr(server, "RESET_LOCK_SECONDS", 0.05)
    assert server._scan_lock.acquire(blocking=False)
    try:
        with mock.patch.object(demo_reset, "reset_demo") as reset:
            busy = demo_client.post(demo.RESET_PATH, headers={"Authorization": "Bearer synthetic-reset-token"})
    finally:
        server._scan_lock.release()
    assert busy.status_code == 409
    reset.assert_not_called()


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

def test_rate_limiter_window():
    limiter = demo.RateLimiter(2, 10)
    assert [limiter.allow("a", now=t) for t in (0, 1, 2)] == [True, True, False]
    assert limiter.allow("b", now=2)
    assert limiter.allow("a", now=10.5)


def test_visitor_key_uses_the_first_forwarded_address():
    assert demo.visitor_key({"x-forwarded-for": "203.0.113.7, 10.0.0.1"}, "10.0.0.9", "a@x") == "203.0.113.7|a@x"
    assert demo.visitor_key({}, "10.0.0.9", "a@x") == "10.0.0.9|a@x"


def test_oversized_or_unsized_bodies_are_refused(demo_client):
    signed_in(demo_client, OPS)
    big = demo_client.post("/api/samples/run", content=b"x" * (demo.MAX_BODY_BYTES + 1),
                           headers={**SAME_ORIGIN, "Content-Type": "application/json"})
    chunked = demo_client.post("/api/samples/run", content=iter([b'{"keys": []}']),
                               headers={**SAME_ORIGIN, "Content-Type": "application/json"})
    assert (big.status_code, chunked.status_code) == (413, 411)


@pytest.mark.parametrize("method, path, body", [
    ("PATCH", f"/api/positions/{uuid4()}/status", {"status": "ACAT", "notes": "n" * 501}),
    ("POST", "/api/users", {"email": "a" * 250 + "@x.io", "role": "advisor"}),
    ("POST", "/api/users", {"email": "not-an-email", "role": "advisor"}),
    ("POST", "/api/clients/sample-okafor/destinations", {"owner": "o" * 121, "target_account_type": "Individual"}),
    ("PATCH", f"/api/destinations/{uuid4()}", {"existing_apex_number": "9" * 41}),
    ("PATCH", f"/api/accounts/{uuid4()}/type", {"account_type": "IRA", "account_type_other": "x" * 61}),
])
def test_long_free_text_is_refused_before_any_write(demo_client, method, path, body):
    signed_in(demo_client, OPS)
    with users(user_row(OPS)), mock.patch.object(db, "get_connection") as connect_:
        response = demo_client.request(method, path, json=body, headers=SAME_ORIGIN)
    assert response.status_code == 400
    connect_.assert_not_called()


def _patched(**counts):
    patches = [mock.patch.object(db, "get_connection", return_value=object()), mock.patch.object(db, "put_connection"),
               mock.patch.object(db, "lock_cap")]
    patches += [mock.patch.object(db, name, return_value=value) for name, value in counts.items()]
    return patches


def test_counts_cap_users_destinations_outbox_and_runs(demo_client):
    signed_in(demo_client, OPS)
    from contextlib import ExitStack

    def call(method, path, body, **counts):
        with ExitStack() as stack:
            for p in _patched(**counts):
                stack.enter_context(p)
            stack.enter_context(users(user_row(OPS)))
            return demo_client.request(method, path, json=body, headers=SAME_ORIGIN)

    assert call("POST", "/api/users", {"email": "new@example.invalid"}, count_users=demo.MAX_USERS).status_code == 429
    assert call("POST", "/api/clients/sample-okafor/destinations", {"target_account_type": "Individual"},
                folder_has_runs=False).status_code == 404
    assert call("POST", "/api/clients/sample-okafor/destinations", {"target_account_type": "Individual"},
                folder_has_runs=True, count_target_accounts=demo.MAX_DESTINATIONS_PER_CLIENT).status_code == 429
    full = call("POST", "/api/samples/run", {"keys": ["okafor", "rossi"]}, count_households=demo.MAX_RUNS - 1)
    assert full.status_code == 429 and "07:00 UTC" in full.json()["detail"]


def test_sample_runs_are_rate_limited_per_visitor(demo_client, monkeypatch):
    monkeypatch.setattr(server, "_sample_runs", demo.RateLimiter(2, 600))
    signed_in(demo_client, OPS)
    with users(user_row(OPS)), \
         mock.patch.object(db, "get_connection", return_value=object()), \
         mock.patch.object(db, "put_connection"), \
         mock.patch.object(db, "count_households", return_value=0), \
         mock.patch.object(server.stand_ins, "run_samples", return_value=[]):
        codes = [demo_client.post("/api/samples/run", json={"keys": ["okafor"]},
                                  headers={**SAME_ORIGIN, "X-Forwarded-For": ip}).status_code
                 for ip in ("203.0.113.7", "203.0.113.7", "203.0.113.7", "198.51.100.4")]
    assert codes == [200, 200, 429, 200]
