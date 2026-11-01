"""
The demo as a visitor uses it (plan T2), through the real routes on a seeded, disposable Postgres schema: sign in
as each persona, run samples, override and flag positions, delete and restore, change an account's type, work
the destinations, save to Drive, export both PDFs, manage users, and find the advisor refused every edit.
"""
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import psycopg2
import pytest
from fastapi.testclient import TestClient

import demo
import demo_reset
import server
from tests.test_demo import ADVISOR, OPS, SAME_ORIGIN, SECRET

ET = ZoneInfo("America/New_York")


@pytest.fixture
def site(pg, monkeypatch):
    """A seeded demo on its own schema, and a client signed in as Jordan Reyes (ops)."""
    name = pg["schema"]()
    env = pg["env"]("DB_", name)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DEMO_MODE", "on")
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("SESSION_SECRET", SECRET)
    monkeypatch.setattr(server, "_sample_runs", demo.RateLimiter(*demo.SAMPLE_RUNS_PER_VISITOR))
    kwargs = {k[3:].lower(): v for k, v in env.items() if k.startswith("DB_")}
    conn = psycopg2.connect(host=kwargs["host"], port=kwargs["port"], dbname=kwargs["name"], user=kwargs["user"],
                            password=kwargs["password"], options=f"-c search_path={kwargs['search_path']}")
    demo_reset.reset_demo(conn, now=datetime.now(ET))
    conn.close()
    client = TestClient(server.app, base_url="https://testserver")
    client.cookies.set(demo.SESSION_COOKIE, demo.sign_session(OPS["email"]))
    yield client
    client.close()


def ok(response, status=200):
    assert response.status_code == status, (response.status_code, response.text[:300])
    return response.json() if "json" in response.headers.get("content-type", "") else response


def household(client, client_name):
    listed = ok(client.get("/api/households?per_page=200"))
    hid = next(h["id"] for h in listed if h["client_name"] == client_name)
    return ok(client.get(f"/api/households/{hid}"))


def position(detail, symbol):
    return next(p for a in detail["accounts"] for p in a["assets"] if p["symbol"] == symbol)


def account(detail, raw_type):
    return next(a for a in detail["accounts"] if a.get("account_type_raw") == raw_type)


def test_a_visitor_works_a_household_end_to_end(site):
    me = ok(site.get("/api/me"))
    assert (me["name"], me["role"]) == ("Jordan Reyes", "ops")

    # Run two samples, as the panel does; each is a new run of its household.
    run = ok(site.post("/api/samples/run", json={"keys": ["okafor", "rossi"]}, headers=SAME_ORIGIN))
    assert [r["status"] for r in run["results"]] == ["success", "success"]
    okafor = household(site, "Okafor Household")
    assert okafor["run_number"] == 3   # the seed has two Okafor runs
    outbox = ok(site.get("/api/outbox"))
    assert outbox[0]["kind"] == "slack" and "2* client(s) processed" in outbox[0]["body"]

    # Override the option to liquidate, with a note; flag the ETF as transferring.
    option = position(okafor, "AAPL 270115C00250000")
    assert option["effective_status"] == "REVIEW"
    ok(site.patch(f"/api/positions/{option['id']}/status", json={"status": "LIQUIDATE",
                  "notes": "Expires before the transfer settles: close it first."}, headers=SAME_ORIGIN))
    vti = position(okafor, "VTI")
    ok(site.patch(f"/api/positions/{vti['id']}/transferring", json={"value": "YES"}, headers=SAME_ORIGIN))
    okafor = household(site, "Okafor Household")
    option = position(okafor, "AAPL 270115C00250000")
    assert (option["effective_status"], option["overridden_by"]) == ("LIQUIDATE", OPS["email"])
    assert position(okafor, "VTI")["transferring"] == "YES"

    # Soft-delete a position and restore it; the same for an account.
    msft = position(okafor, "MSFT")
    ok(site.delete(f"/api/positions/{msft['id']}", headers=SAME_ORIGIN))
    assert all(p["symbol"] != "MSFT" for a in household(site, "Okafor Household")["accounts"] for p in a["assets"])
    ok(site.patch(f"/api/positions/{msft['id']}/restore", headers=SAME_ORIGIN))
    assert position(household(site, "Okafor Household"), "MSFT")["effective_status"] == "ACAT"
    roth = account(okafor, "Roth IRA")
    ok(site.delete(f"/api/accounts/{roth['id']}", headers=SAME_ORIGIN))
    assert all(a["id"] != roth["id"] for a in household(site, "Okafor Household")["accounts"])
    ok(site.patch(f"/api/accounts/{roth['id']}/restore", headers=SAME_ORIGIN))

    # Change the individual account to a 401(k): the rules run again, and the override survives.
    individual = account(okafor, "Individual")
    changed = ok(site.patch(f"/api/accounts/{individual['id']}/type", json={"account_type": "401k"},
                            headers=SAME_ORIGIN))
    assert changed["is_rollover"] is True and changed["apex_rules_loaded"] is True
    assert changed["overrides_preserved"] == 1
    okafor = household(site, "Okafor Household")
    assert position(okafor, "NVDA")["effective_status"] == "LIQUIDATE"
    assert position(okafor, "AAPL 270115C00250000")["override_status"] == "LIQUIDATE"

    # Destinations: add one, mark it already open, move a source to it, then remove it.
    folder = okafor["source_folder_id"]
    added = ok(site.post(f"/api/clients/{folder}/destinations",
                         json={"owner": "Ada Okafor", "target_account_type": "Roth IRA"}, headers=SAME_ORIGIN))
    ok(site.patch(f"/api/destinations/{added['id']}", json={"needs_to_be_opened": False,
                  "existing_apex_number": "DEMO-000123"}, headers=SAME_ORIGIN))
    link = okafor["destinations"][0]["sources"][0]["link_id"]
    ok(site.post("/api/source-accounts/reassign", json={"link_id": link, "target_account_id": added["id"]},
                 headers=SAME_ORIGIN))
    moved = next(d for d in household(site, "Okafor Household")["destinations"] if d["id"] == added["id"])
    assert [s["link_id"] for s in moved["sources"]] == [link] and moved["needs_to_be_opened"] is False
    # A destination with a source mapped to it can't be removed (the source would be stranded); move it back first.
    assert site.delete(f"/api/destinations/{added['id']}", headers=SAME_ORIGIN).status_code == 409
    original = okafor["destinations"][0]["id"]
    ok(site.post("/api/source-accounts/reassign", json={"link_id": link, "target_account_id": original},
                 headers=SAME_ORIGIN))
    ok(site.delete(f"/api/destinations/{added['id']}", headers=SAME_ORIGIN))
    # Nor can a source be moved to another client's destination.
    other = household(site, "Nakamura Household")["destinations"][0]["id"]
    assert site.post("/api/source-accounts/reassign", json={"link_id": link, "target_account_id": other},
                     headers=SAME_ORIGIN).status_code == 404
    assert site.post("/api/source-accounts/reassign", headers=SAME_ORIGIN,
                     json={"link_id": link, "source_folder_id": household(site, "Nakamura Household")["source_folder_id"],
                           "new_target_account_type": "Individual"}).status_code == 400
    assert link in [s["link_id"] for d in household(site, "Okafor Household")["destinations"] for s in d["sources"]]

    # Save to Drive lands in the Outbox and stamps the review; both PDFs render.
    saved = ok(site.post(f"/api/households/{okafor['id']}/save-to-drive", headers=SAME_ORIGIN))
    assert saved["reviewed_by"] == OPS["email"] and saved["web_view_link"] == ""
    assert ok(site.get("/api/outbox"))[0]["kind"] == "drive"
    single = ok(site.get(f"/api/households/{okafor['id']}/pdf"))
    every = ok(site.get("/api/households/export/pdf"))
    for pdf in (single, every):
        assert pdf.headers["content-type"] == "application/pdf" and pdf.content.startswith(b"%PDF")
    assert len(every.content) > len(single.content) * 10   # all 39 households, rule notes and all


def test_users_can_be_managed_but_the_personas_are_fenced(site):
    added = ok(site.post("/api/users", json={"email": "new.analyst@example.com", "role": "advisor"},
                         headers=SAME_ORIGIN), 201)
    ok(site.patch(f"/api/users/{added['id']}", json={"role": "ops"}, headers=SAME_ORIGIN))
    listed = ok(site.get("/api/users"))
    assert {u["email"]: u["role"] for u in listed}["new.analyst@example.com"] == "ops"
    assert {u["email"] for u in listed if u["persona"]} == {OPS["email"], ADVISOR["email"]}
    persona = next(u for u in listed if u["email"] == ADVISOR["email"])
    assert site.patch(f"/api/users/{persona['id']}", json={"role": "ops"}, headers=SAME_ORIGIN).status_code == 403
    assert site.delete(f"/api/users/{persona['id']}", headers=SAME_ORIGIN).status_code == 403
    ok(site.delete(f"/api/users/{added['id']}", headers=SAME_ORIGIN))


def test_the_advisor_reads_everything_and_changes_nothing(site):
    site.cookies.set(demo.SESSION_COOKIE, demo.sign_session(ADVISOR["email"]))
    okafor = household(site, "Okafor Household")
    assert ok(site.get(f"/api/households/{okafor['id']}/pdf")).content.startswith(b"%PDF")
    vti = position(okafor, "VTI")
    acct = okafor["accounts"][0]
    refused = [
        site.patch(f"/api/positions/{vti['id']}/status", json={"status": "REVIEW"}, headers=SAME_ORIGIN),
        site.patch(f"/api/positions/{vti['id']}/transferring", json={"value": "NO"}, headers=SAME_ORIGIN),
        site.delete(f"/api/positions/{vti['id']}", headers=SAME_ORIGIN),
        site.delete(f"/api/accounts/{acct['id']}", headers=SAME_ORIGIN),
        site.patch(f"/api/accounts/{acct['id']}/type", json={"account_type": "IRA"}, headers=SAME_ORIGIN),
        site.post(f"/api/clients/{okafor['source_folder_id']}/destinations",
                  json={"target_account_type": "Individual"}, headers=SAME_ORIGIN),
        site.post(f"/api/households/{okafor['id']}/save-to-drive", headers=SAME_ORIGIN),
        site.post("/api/samples/run", json={"keys": ["okafor"]}, headers=SAME_ORIGIN),
        site.get("/api/users"),
        site.get("/api/outbox"),
        site.get("/api/samples"),
    ]
    assert [r.status_code for r in refused] == [403] * len(refused)
    assert position(household(site, "Okafor Household"), "VTI")["effective_status"] == "ACAT"


def test_unknown_records_are_404_not_500(site):
    missing = str(uuid4())
    for method, path, body in [
        ("PATCH", f"/api/positions/{missing}/status", {"status": "ACAT"}),
        ("DELETE", f"/api/positions/{missing}", None),
        ("PATCH", f"/api/accounts/{missing}/restore", None),
        ("GET", f"/api/households/{missing}", None),
        ("POST", f"/api/households/{missing}/save-to-drive", None),
    ]:
        response = site.request(method, path, json=body, headers=SAME_ORIGIN)
        assert response.status_code == 404, (method, path, response.status_code)


def test_a_new_account_type_keeps_a_flagged_account_in_review(site):
    """Rossi's statement doesn't reconcile with its printed total, so validation holds every position in REVIEW.
    Changing the account's type re-runs the rules, but the totals still don't reconcile."""
    rossi = household(site, "Rossi Household")
    flagged = next(a for a in rossi["accounts"] if a.get("validation_status") == "WARNING")
    assert {p["transfer_eligible"] for p in flagged["assets"]} == {"REVIEW"}
    new_type = "Joint" if flagged["account_type"] != "Joint" else "Individual"
    ok(site.patch(f"/api/accounts/{flagged['id']}/type", json={"account_type": new_type}, headers=SAME_ORIGIN))
    after = next(a for a in household(site, "Rossi Household")["accounts"] if a["id"] == flagged["id"])
    assert after["account_type"] == new_type
    assert {p["transfer_eligible"] for p in after["assets"]} == {"REVIEW"}
    assert all(p["transfer_notes"].startswith("Validation Override") for p in after["assets"])


def test_restoring_an_account_leaves_a_position_deleted_on_its_own_deleted(site):
    okafor = household(site, "Okafor Household")
    joint = account(okafor, "Joint Tenants with Right of Survivorship (JTWROS)")
    msft = position(okafor, "MSFT")
    ok(site.delete(f"/api/positions/{msft['id']}", headers=SAME_ORIGIN))
    assert site.patch(f"/api/positions/{msft['id']}/status", json={"status": "LIQUIDATE"},
                      headers=SAME_ORIGIN).status_code == 404  # a deleted position takes no override
    ok(site.delete(f"/api/accounts/{joint['id']}", headers=SAME_ORIGIN))
    ok(site.patch(f"/api/accounts/{joint['id']}/restore", headers=SAME_ORIGIN))
    restored = next(a for a in household(site, "Okafor Household")["accounts"] if a["id"] == joint["id"])
    symbols = {p["symbol"] for p in restored["assets"]}
    assert "MSFT" not in symbols and {"VTI", "BBGLX", "AAPL"} <= symbols
