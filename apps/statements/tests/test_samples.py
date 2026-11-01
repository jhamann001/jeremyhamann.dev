"""The sample statements, their prepared answers in place of the model, and the reference lookups that stand in for
the firm's Notion databases. The end-to-end tests run every sample through the real pipeline on disposable Postgres,
with the same answers the demo uses."""
import json
import re
import zlib
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import psycopg2
import pytest
from google.genai import types

import automation_pipeline as ap
import db
import stand_ins
from samples import AS_OF, SAMPLES, SAMPLES_BY_KEY, render_document, shift_document
from stand_ins import (
    CALLS, DemoApexRulesDB, DemoCustodianDB, DemoRestrictionDB, DemoTickerDB, ReplayGenaiClient, ReplayMissing,
    extraction_answer, prepared_answers, prescreen_answer, replay_shift_days, sha256, shift_answer_dates,
    shift_dates_in,
)

REPO = Path(__file__).resolve().parents[3]
WORLD = json.loads((REPO / "synthetic" / "world.json").read_text())
ALL_DOCUMENTS = [(s, d) for s in SAMPLES for d in s.documents]


def page_text(pdf: bytes) -> bytes:
    """The PDF's content streams, inflated: where its printed text lives."""
    return b"".join(zlib.decompress(m.group(1)) for m in re.finditer(rb"stream\n(.*?)\nendstream", pdf, re.S))


# ---------------------------------------------------------------------------
# The statements
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("sample, doc", ALL_DOCUMENTS, ids=[d.filename for _, d in ALL_DOCUMENTS])
def test_every_statement_is_deterministic_and_says_it_is_a_sample(sample, doc):
    pdf = render_document(doc)
    assert pdf == render_document(doc)
    assert pdf.startswith(b"%PDF")
    expected = "Hypothetical illustration" if doc.kind == "proposal" else f"Not issued by {doc.issuer}"
    assert expected.encode() in page_text(pdf)
    for account in doc.accounts:
        assert account.number is None or account.number.startswith("DEMO-")


def test_only_the_planted_mismatch_misses_its_printed_total():
    mismatched = [(s.key, a.title) for s in SAMPLES for d in s.documents for a in d.accounts
                  if a.total != a.computed_total]
    assert mismatched == [("rossi", "Individual")]


def test_the_okafor_statement_is_the_universe_story():
    story = next(s for s in WORLD["stories"]["statements"] if s["id"] == "s1")
    doc = SAMPLES_BY_KEY["okafor"].documents[0]
    assert [a.total for a in doc.accounts] == [a["total"] for a in story["accounts"]]
    for account, told in zip(doc.accounts, story["accounts"]):
        assert account.number.endswith(told["suffix"])
        values = {(h.symbol or "").split()[0]: h.value for h in account.holdings}
        for p in told["positions"]:
            if p["symbol"] != "CASH":
                assert values[p["symbol"].split()[0]] == p["value"]


def test_statement_people_are_universe_members():
    members = {f"{m['first']} {m['last']}" for h in WORLD["storyHouseholds"] for m in h["members"]}
    for sample, doc in ALL_DOCUMENTS:
        for account in doc.accounts:
            for name in re.split(r",\s*", account.holders.replace(", Trustee", "")):
                assert name in members, (sample.key, name)
        if doc.prepared_for:
            assert doc.prepared_for in members


def test_shifted_documents_move_every_printed_date():
    doc = SAMPLES_BY_KEY["okafor"].documents[0]
    moved = shift_document(doc, 14)
    assert moved.period_end == doc.period_end + timedelta(days=14)
    assert moved.accounts[0].holdings[0].lots[0].acquired == "03/28/2019"
    bank = shift_document(SAMPLES_BY_KEY["alvarez"].documents[0], 7)
    assert bank.lines[0][0] == "09/08/2026"
    assert shift_document(doc, 0) is doc


# ---------------------------------------------------------------------------
# Reference lookups
# ---------------------------------------------------------------------------

def test_the_ticker_table_covers_the_universe_securities():
    tickers = DemoTickerDB()
    symbols = [s["symbol"] for s in WORLD["securities"] if s["vehicle"] != "money-market"]
    tickers.query_symbols(symbols)
    assert set(tickers.tickers) == set(symbols)


def test_fund_restrictions_use_the_pipelines_own_rule():
    funds = DemoRestrictionDB()
    funds.query_symbols(["BBGLX", "PRGFX", "TRBCX", "NOPEX"])
    assert funds.check_symbol("PRGFX")["transferrable"] is True
    assert funds.check_symbol("BBGLX")["override_action"] == "REVIEW"
    assert funds.check_symbol("TRBCX")["transferrable"] is False
    assert funds.check_symbol("NOPEX")["in_notion"] is False


def test_custodian_library_matches_the_transfer_trackers():
    source = (REPO / "apps" / "acat" / "src" / "lib" / "demo" / "custodian-library.ts").read_text()
    names = re.findall(r'^    name: "([^"]+)",$', source, re.M)
    dtcs = re.findall(r'^    dtc: (null|"[^"]*"),$', source, re.M)
    from custodian_library import CUSTODIANS
    assert [c["name"] for c in CUSTODIANS] == names
    assert [c["dtc"] for c in CUSTODIANS] == [None if d == "null" else json.loads(d) for d in dtcs]


@pytest.mark.parametrize("printed, expected", [
    ("Edward Jones", "Edward Jones"), ("Charles Schwab", "Charles Schwab"), ("Fidelity", "Fidelity"),
    ("BNY Investments", "BNY Investments"), ("T. Rowe Price", "T. Rowe Price / Pershing"),
])
def test_every_sample_custodian_has_notes(printed, expected):
    match = DemoCustodianDB().lookup(printed)
    assert match["name"] == expected and match["dtcc_number"]


def test_bny_notes_say_it_is_not_a_standard_acat():
    assert DemoCustodianDB().lookup("BNY Investments")["acat_timeline"].startswith("Not a standard ACAT")


def test_receiving_custodian_rules_come_from_the_csv():
    rules = DemoApexRulesDB()
    assert len(rules.rules) == 15
    assert rules.lookup_account("Revocable Trust")["rule_type"] == "UNSUPPORTED"
    assert rules.lookup_asset("Fixed Income")["account_type"] == "Fixed Income / Bond Accounts"
    assert rules.lookup_asset("Cash") is None
    assert "Cedar Ridge Wealth" in rules.lookup_account("trust")["notes"]


# ---------------------------------------------------------------------------
# The model: prepared answers, replayed
# ---------------------------------------------------------------------------

def test_replay_shift_is_whole_weeks_and_never_backwards():
    assert replay_shift_days(AS_OF) == 0
    assert replay_shift_days(AS_OF + timedelta(days=6)) == 0
    assert replay_shift_days(AS_OF + timedelta(days=20)) == 14
    assert replay_shift_days(AS_OF - timedelta(days=30)) == 0


@pytest.mark.parametrize("before, after", [
    ("09/30/2026", "10/14/2026"),
    ("2026-09-30", "2026-10-14"),
    ("September 30, 2026", "October 14, 2026"),
    ("Sep 30, 2026", "Oct 14, 2026"),
    ("09/01/2026 - 09/30/2026", "09/15/2026 - 10/14/2026"),
    ("as of the quarter end", "as of the quarter end"),
])
def test_dates_shift_in_their_own_format(before, after):
    assert shift_dates_in(before, 14) == after


def test_only_statement_and_lot_dates_shift():
    answer = json.dumps([{
        "statement_date": "09/30/2026",
        "positions": [{"description": "US TREASURY NOTE DUE 05/15/2029", "lots": [{"acquisition_date": "03/14/2019"}]}],
    }])
    shifted = json.loads(shift_answer_dates("```json\n" + answer + "\n```", 7))
    assert shifted[0]["statement_date"] == "10/07/2026"
    assert shifted[0]["positions"][0]["lots"][0]["acquisition_date"] == "03/21/2019"
    assert shifted[0]["positions"][0]["description"].endswith("05/15/2029")
    assert shift_answer_dates("not json {", 7) == "not json {"


def _contents(pdf: bytes, call: str):
    return [types.Part.from_bytes(data=pdf, mime_type="application/pdf"), CALLS[call]]


def test_replay_answers_only_a_prepared_pdf_and_prompt():
    pdf = render_document(SAMPLES_BY_KEY["lindqvist"].documents[0])
    replay = ReplayGenaiClient({(sha256(pdf), sha256(CALLS["prescreen"])): '{"doc_type": "x"}'})
    assert replay.models.generate_content(model="m", contents=_contents(pdf, "prescreen")).text == '{"doc_type": "x"}'
    for contents in (_contents(pdf, "extraction"), _contents(pdf + b" ", "prescreen")):
        with pytest.raises(ReplayMissing) as missing:
            replay.models.generate_content(model="m", contents=contents)
        assert not re.search(r"\d", str(missing.value))  # the pipeline would retry on a status-code look-alike


def test_an_unprepared_pdf_fails_without_retrying(monkeypatch):
    pdf = render_document(SAMPLES_BY_KEY["lindqvist"].documents[0])
    monkeypatch.setattr(ap, "_genai_client", ReplayGenaiClient({}))
    monkeypatch.setattr(ap.time, "sleep", lambda s: pytest.fail("retried a refused replay"))
    path = Path(pytest.importorskip("tempfile").mkstemp(suffix=".pdf")[1])
    path.write_bytes(pdf)
    try:
        assert ap.classify_document_with_gemini(str(path))["doc_type"] == "unknown"
        with pytest.raises(ReplayMissing):
            ap.analyze_document_with_gemini(str(path))
    finally:
        path.unlink()


def test_prepared_answers_cover_exactly_what_the_pipeline_asks_for():
    answers = prepared_answers()
    for _, doc in ALL_DOCUMENTS:
        pdf = sha256(render_document(doc))
        assert (pdf, sha256(CALLS["prescreen"])) in answers
        stops = doc.kind in ("bank", "proposal")
        assert ((pdf, sha256(CALLS["extraction"])) in answers) is not stops, doc.filename
    assert len(answers) == 22


def test_prepared_answers_parse_through_the_pipelines_own_extraction_code(monkeypatch, tmp_path):
    """The answers go through analyze_document_with_gemini's parsing and lot consolidation unchanged."""
    monkeypatch.setattr(ap, "_genai_client", ReplayGenaiClient.prepared(AS_OF))
    doc = SAMPLES_BY_KEY["okafor"].documents[0]
    path = tmp_path / doc.filename
    path.write_bytes(render_document(doc))
    assert ap.classify_document_with_gemini(str(path)) == prescreen_answer(doc)
    accounts = ap.analyze_document_with_gemini(str(path))
    assert [a["account_number"] for a in accounts] == [a.number for a in doc.accounts]
    vti = next(p for p in accounts[0]["assets"] if p["symbol"] == "VTI")
    assert vti["market_value"] == 236616.80 and len(vti["lots"]) == 2
    assert extraction_answer(doc)[0]["statement_portfolio_total"] == 587240.18


# ---------------------------------------------------------------------------
# End to end: every sample through the real pipeline
# ---------------------------------------------------------------------------

def connect(env):
    kwargs = {k[3:].lower(): v for k, v in env.items() if k.startswith("DB_")}
    return psycopg2.connect(host=kwargs["host"], port=kwargs["port"], dbname=kwargs["name"], user=kwargs["user"],
                            password=kwargs["password"], options=f"-c search_path={kwargs['search_path']}")


@pytest.fixture
def ran(pg, monkeypatch):
    """Every sample, run once through run_samples with the demo's prepared answers, on a disposable schema."""
    monkeypatch.delenv("DEMO_MODE", raising=False)
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    conn = connect(pg["env"]("DB_", pg["schema"]()))
    try:
        results = stand_ins.run_samples([s.key for s in SAMPLES], conn)
        households = {r["sample"]: db.get_household_detail(conn, r["household_id"])
                      for r in results if r["status"] == "success"}
        yield SimpleNamespace(results=results, households=households, conn=conn)
    finally:
        conn.close()


def _positions(household, account_title=None):
    out = {}
    for account in household["accounts"]:
        if account_title and account.get("account_type_raw") != account_title:
            continue
        for p in account["assets"]:
            out[p["symbol"]] = p["effective_status"]
    return out


def test_every_sample_runs_and_restores_the_model_client(ran):
    assert [r["status"] for r in ran.results] == ["success"] * len(SAMPLES)
    assert ap._genai_client is None


def test_okafor_bridge_builder_and_option_go_to_review(ran):
    positions = _positions(ran.households["okafor"])
    assert positions["BBGLX"] == "REVIEW" and positions["AAPL 270115C00250000"] == "REVIEW"
    for symbol in ("VTI", "MSFT", "AAPL", "BND", "VXUS", "AVUV", "NVDA"):
        assert positions[symbol] == "ACAT", symbol
    account = ran.households["okafor"]["accounts"][0]
    assert account["custodian_intel"]["dtcc_number"] == "0057" and "Bridge Builder" in account["custodian_intel"]["details"]


def test_delgado_trust_is_unsupported(ran):
    assert set(_positions(ran.households["delgado"]).values()) == {"UNSUPPORTED"}


def test_nakamura_is_read_and_flagged_stale(ran):
    account = ran.households["nakamura"]["accounts"][0]
    assert account["is_stale"] is True
    assert set(_positions(ran.households["nakamura"]).values()) == {"ACAT"}
    assert all(not a["is_stale"] for k, h in ran.households.items() if k != "nakamura" for a in h["accounts"])


def test_brennan_401k_liquidates_and_the_brokerage_account_transfers(ran):
    household = ran.households["brennan"]
    assert set(_positions(household, "401(k)").values()) == {"LIQUIDATE"}
    assert set(_positions(household, "Individual").values()) == {"ACAT"}


def test_morgan_carries_the_non_acat_custodian_notes(ran):
    intel = ran.households["morgan"]["accounts"][0]["custodian_intel"]
    assert intel["matched_name"] == "BNY Investments" and intel["acat_timeline"].startswith("Not a standard ACAT")


def test_lindqvist_is_clean(ran):
    household = ran.households["lindqvist"]
    assert set(_positions(household).values()) == {"ACAT"}
    assert household["accounts"][0]["validation_status"] == "VALID"


def test_alvarez_planted_cases(ran):
    household = ran.households["alvarez"]
    docs = {d["filename"]: d["status"] for d in household["doc_results"]}
    assert docs == {"Alvarez_SchwabBank_Checking_2026-09.pdf": "rejected", "Alvarez_Schwab_2026-09.pdf": "extracted"}
    positions = _positions(household, "Individual")
    assert positions["VTI"] == "ACAT"
    assert positions["9128DEMO4"] == "REVIEW"     # a bond: the receiving custodian's fixed-income rule
    assert positions["BAC PRL"] == "REVIEW"       # a preferred the ticker table can't confirm
    assert positions["NSRGF"] == "REVIEW"         # a foreign ordinary share
    assert set(_positions(household, "Schwab Bank Investor Checking (linked)").values()) == {"ACH/WIRE"}


def test_rossi_mismatch_sends_the_whole_account_to_review_and_the_proposal_is_turned_away(ran):
    household = ran.households["rossi"]
    account = household["accounts"][0]
    assert account["validation_status"] == "WARNING"
    assert set(_positions(household).values()) == {"REVIEW"}
    assert {d["filename"]: d["status"] for d in household["doc_results"]}["Rossi_Proposal_Hypothetical.pdf"] == "rejected"


def test_chen_registrations_share_an_investor_number(ran):
    household = ran.households["chen"]
    assert {a["account_registration"] for a in household["accounts"]} == {"Roth IRA", "Rollover IRA"}
    positions = _positions(household)
    assert positions["TRBCX"] == "REVIEW"
    assert {positions[s] for s in ("PRGFX", "PRWCX", "PRFDX")} == {"ACAT"}
    assert all(a["validation_status"] == "VALID" for a in household["accounts"])


def test_a_second_run_supersedes_the_first(ran):
    again = stand_ins.run_samples(["lindqvist"], ran.conn)
    with ran.conn.cursor() as cur:
        cur.execute("SELECT id::text, run_number, superseded_by::text FROM households "
                    "WHERE source_folder_id = 'sample-lindqvist' ORDER BY run_number")
        runs = cur.fetchall()
    first = next(r["household_id"] for r in ran.results if r["sample"] == "lindqvist")
    assert runs == [(first, 1, again[0]["household_id"]), (again[0]["household_id"], 2, None)]



@pytest.mark.parametrize("account_type, rule", [
    ("Savings", "Checking, Savings, and Cash Accounts"),  # not the 529 rule's "college savings"
    ("IRA", None),  # not the inherited rule's "inherited ira"
    ("Brokerage account pursuant to agreement", None),  # "rsu" inside "pursuant"
    ("Individual", None),
    ("Revocable Living Trust", "Trust Accounts"),
    ("Coverdell 529 Plan", "529 College Savings Plans"),
    ("Former employer 401(k)", "Employer-Sponsored Retirement Plans (401k, 403b, TSP)"),
    ("SEP IRA", "SEP/Simple IRAs"),
])
def test_apex_rules_match_whole_keywords_in_the_account_type(account_type, rule):
    match = stand_ins.demo_apex_rules().lookup_account(account_type)
    assert (match["account_type"] if match else None) == rule
