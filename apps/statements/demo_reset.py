"""
The demo's starting state and its nightly reset (plan S6).

reset_demo(conn) puts the database back to the seed in one transaction:
  1. empty every table;
  2. restore the two sign-in personas;
  3. load the client roster, the accounts already open at the receiving custodian, from the synthetic universe
     (synthetic/out/universe.json), in place of the firm's roster feed;
  4. run the seed's statements through the real pipeline (process_client_folder with the prepared answers):
     the nine sample households, analyzed over the last few business days; the universe's thirty other
     households, as statements from their previous custodians analyzed over the past weeks before they moved in;
     and an earlier run for some of them, so their run tabs have history;
  5. date every run on a New York business day (weekdays; market holidays aren't modelled), and add a few of
     Jordan Reyes's review edits: an override with a note, a "transferring" flag, a soft delete, reviewed stamps.

The pipeline commits as it goes. Here those commits wait for the reset's own, so nothing is visible until the
whole seed is in, and a failure rolls all of it back: the demo keeps yesterday's data.

Called by POST /api/internal/demo-reset (the Worker's nightly cron at 07:00 UTC) and from the command line (the
deploy), which first creates or updates the schema over the database's direct (unpooled) host:

    DATABASE_URL=postgresql://... python demo_reset.py
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import time
import uuid
import zlib
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import automation_pipeline as ap
import db as pipeline_db
import demo
import stand_ins
from samples import SAMPLES_BY_KEY, Account, Document, Holding, Sample

log = logging.getLogger("statement-pipeline")
ET = ZoneInfo("America/New_York")

REVIEWER = demo.persona_by_key("jordan-reyes")["email"]


def demo_run_id(source_folder_id: str, run_number: int) -> str:
    """The id every demo gives this client folder's run: the advisor platform's demo seed derives the same one from the
    same key (its runId), so its "Open in the Statement Analyzer demo" link opens this run, and it stays the same
    through every reset."""
    h = hashlib.sha256(f"demo-uuid:pipeline:run:{source_folder_id}#{run_number}".encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-4{h[13:16]}-a{h[17:20]}-{h[20:32]}"

# Every table the app writes. users is emptied too: visitors' added users go, and the personas come back.
_TABLES = ("households", "accounts", "positions", "target_accounts", "source_account_links",
           "active_accounts_roster", "outbox", "mcp_tokens", "users")


class ResetAborted(RuntimeError):
    """A step of the seed failed; the whole reset rolls back."""


class _HeldCommits:
    """The reset's connection as the pipeline sees it: commits are held for the reset's own, and a rollback by
    any step aborts the whole reset rather than undoing part of it."""

    def __init__(self, conn):
        self._conn = conn
        self.rolled_back = False  # kept in case a step's own `except Exception` swallows the ResetAborted

    def commit(self):
        pass

    def rollback(self):
        self.rolled_back = True
        raise ResetAborted("A step of the seed rolled back")

    def __getattr__(self, name):
        return getattr(self._conn, name)


def load_universe(path: Optional[str] = None) -> dict:
    """The shared synthetic universe. DEMO_UNIVERSE_PATH overrides the repo location (the image sets it, and
    there the repo layout doesn't exist: the app sits at /app)."""
    configured = path or os.getenv("DEMO_UNIVERSE_PATH")
    file = Path(configured) if configured else Path(__file__).resolve().parents[2] / "synthetic" / "out" / "universe.json"
    return json.loads(file.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------

def business_day_before(now: datetime, days: int, minutes_after_nine: int = 0) -> datetime:
    """The New York weekday *days* business days before *now*, at 9:00 ET plus *minutes_after_nine*."""
    d = now.astimezone(ET).date()
    counted = 0
    while counted < days:
        d -= timedelta(days=1)
        if d.weekday() < 5:
            counted += 1
    return datetime(d.year, d.month, d.day, 9, 0, tzinfo=ET) + timedelta(minutes=minutes_after_nine)


def _month_end_before(d: date) -> date:
    return d.replace(day=1) - timedelta(days=1)


def _period_for(processed: datetime, shift_days: int) -> tuple[date, date]:
    """The statement period a run analyzed: the month ending before the run (at least five days before), written
    in the universe's as-of dates so that after the replay's shift it reads as that month."""
    shown_end = _month_end_before(processed.date() - timedelta(days=5) + timedelta(days=1))
    shown_start = shown_end.replace(day=1)
    return shown_start - timedelta(days=shift_days), shown_end - timedelta(days=shift_days)


# ---------------------------------------------------------------------------
# The universe's households, as statements from their previous custodians
# ---------------------------------------------------------------------------

SENDING_CUSTODIANS = ("Charles Schwab", "Fidelity", "Edward Jones", "Charles Schwab", "Fidelity", "BNY Investments")
CUSTODIAN_CODES = {"Edward Jones": "4417", "Charles Schwab": "2241", "Fidelity": "7745", "BNY Investments": "8810"}
CUSTODIAN_SHORT = {"Edward Jones": "EdwardJones", "Charles Schwab": "Schwab", "Fidelity": "Fidelity",
                   "BNY Investments": "BNY"}
ACCOUNT_TITLES = {
    "individual": "Individual",
    "joint-taxable": "Joint Tenants with Right of Survivorship",
    "roth-ira": "Roth IRA",
    "traditional-ira": "Traditional IRA",
    "rollover-ira": "Rollover IRA",
    "sep-ira": "SEP IRA",
    "trust": "Revocable Trust",
}
TAXABLE = {"individual", "joint-taxable", "trust"}


def _members(universe: dict, household_id: str) -> list[str]:
    return [f"{p['first']} {p['last']}" for p in universe["people"] if p["household"] == household_id]


def account_owner(universe: dict, account: dict, index: int) -> str:
    """Who an account belongs to, as statements print it: every member for a joint account, else one member
    (taking turns in a two-person household). The roster uses the same rule, so its suggestions match."""
    members = _members(universe, account["household"])
    if account["type"] == "joint-taxable":
        return ", ".join(members)
    return members[index % len(members)]


def _quantity(q: float) -> str:
    return f"{q:,.0f}" if float(q).is_integer() else f"{q:,.3f}"


def _basis_factor(*keys: str) -> float:
    return 0.70 + (zlib.crc32("|".join(keys).encode()) % 25) / 100


def history_document(universe: dict, household: dict, custodian: str, period: tuple[date, date],
                     scale: float = 1.0) -> Document:
    """The statement a universe household's previous custodian sent before it moved in: its accounts and
    holdings as the universe has them now (scaled for an earlier statement)."""
    names = {s["symbol"]: s["name"] for s in universe["securities"]}
    accounts = []
    for index, acct in enumerate(a for a in universe["accounts"] if a["household"] == household["id"]):
        holdings = []
        for h in (x for x in universe["holdings"] if x["account"] == acct["id"]):
            value = round(h["value"] * scale, 2)
            basis = round(value * _basis_factor(household["id"], h["symbol"]), 2) if acct["type"] in TAXABLE else None
            holdings.append(Holding(h["symbol"], names.get(h["symbol"], h["symbol"]), _quantity(h["quantity"]),
                                    round(value / h["quantity"], 2), value, basis))
        accounts.append(Account(
            title=ACCOUNT_TITLES.get(acct["type"], "Individual"),
            number=f"DEMO-{CUSTODIAN_CODES[custodian]}-{acct['number'][-4:]}",
            holders=account_owner(universe, acct, index),
            holdings=tuple(holdings),
        ))
    last = household["name"].split()[0]
    shown_month = (period[1]).strftime("%Y-%m")
    return Document(
        filename=f"{last}_{CUSTODIAN_SHORT[custodian]}_{shown_month}.pdf", kind="brokerage", issuer=custodian,
        period_start=period[0], period_end=period[1], accounts=tuple(accounts),
    )


def _scaled_sample(sample: Sample, scale: float, period: tuple[date, date], filename_month: str) -> Sample:
    """An earlier statement for a sample household: the same accounts, values scaled, an earlier period."""
    documents = []
    for doc in sample.documents:
        accounts = tuple(replace(a, holdings=tuple(
            replace(h, value=round(h.value * scale, 2), price=round(h.price * scale, 2) if h.price else h.price,
                    lots=tuple(replace(lot, value=round(lot.value * scale, 2)) for lot in h.lots))
            for h in a.holdings), cash=round(a.cash * scale, 2), printed_total=None) for a in doc.accounts)
        stem = doc.filename.rsplit("_", 1)[0]
        documents.append(replace(doc, accounts=accounts, period_start=period[0], period_end=period[1],
                                 filename=f"{stem}_{filename_month}.pdf"))
    return replace(sample, documents=tuple(documents))


# ---------------------------------------------------------------------------
# The seed
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SeedRun:
    sample: Sample
    folder_id: str
    processed_at: datetime


# Business days before the reset that each sample household was last run, and minutes after 9:00 ET.
SAMPLE_RUN_DAYS = {"okafor": (1, 95), "lindqvist": (1, 230), "brennan": (2, 40), "rossi": (2, 300),
                   "morgan": (3, 125), "chen": (3, 410), "delgado": (4, 70), "alvarez": (5, 180),
                   "nakamura": (6, 260)}


def seed_plan(universe: dict, now: datetime) -> list[SeedRun]:
    """Every run the seed makes, oldest first, so each folder's later run supersedes its earlier one."""
    shift = stand_ins.replay_shift_days(now.astimezone(ET).date())
    runs = []
    for key, (days, minutes) in SAMPLE_RUN_DAYS.items():
        runs.append(SeedRun(SAMPLES_BY_KEY[key], stand_ins.sample_folder_id(key),
                            business_day_before(now, days, minutes)))
    # Okafor's previous quarter, so a story household has a run history too.
    okafor_earlier = business_day_before(now, 66, 150)
    shown_end = date(okafor_earlier.year, okafor_earlier.month, 1) - timedelta(days=1)
    runs.append(SeedRun(
        _scaled_sample(SAMPLES_BY_KEY["okafor"], 0.96,
                       (shown_end.replace(day=1) - timedelta(days=shift), shown_end - timedelta(days=shift)),
                       shown_end.strftime("%Y-%m")),
        stand_ins.sample_folder_id("okafor"), okafor_earlier))

    generated = [h for h in universe["households"] if not h.get("story")]
    for i, household in enumerate(generated):
        custodian = SENDING_CUSTODIANS[i % len(SENDING_CUSTODIANS)]
        folder = f"universe-{household['id']}"
        latest = business_day_before(now, 3 + (i * 11) % 42, (i * 53) % 480)
        doc = history_document(universe, household, custodian, _period_for(latest, shift))
        runs.append(SeedRun(Sample(f"universe-{household['id']}", household["name"], custodian, "", (doc,)),
                            folder, latest))
        if i % 4 == 0:  # an earlier statement, about a month before
            earlier = business_day_before(now, 3 + (i * 11) % 42 + 22, (i * 29) % 480)
            doc = history_document(universe, household, custodian, _period_for(earlier, shift), scale=0.97)
            runs.append(SeedRun(Sample(f"universe-{household['id']}-earlier", household["name"], custodian, "",
                                       (doc,)), folder, earlier))
    return sorted(runs, key=lambda r: r.processed_at)


def roster_rows(universe: dict) -> list[tuple]:
    """The receiving custodian's open accounts, one row per universe account: what the roster feed supplied."""
    names = {h["id"]: h["name"] for h in universe["households"]}
    rows, index_in_household = [], {}
    for acct in universe["accounts"]:
        index = index_in_household.get(acct["household"], 0)
        index_in_household[acct["household"]] = index + 1
        owner = account_owner(universe, acct, index)
        title = ACCOUNT_TITLES.get(acct["type"], "Individual")
        rows.append((names[acct["household"]], owner, pipeline_db.normalize_owner(owner), title,
                     pipeline_db.normalize_acct_type(title), title, acct["number"], acct["number"], acct["value"]))
    return rows


def _position_id(cur, household_id: str, symbol: str) -> str:
    cur.execute(
        """SELECT p.id FROM positions p JOIN accounts a ON a.id = p.account_id
           WHERE a.household_id = %s AND p.symbol = %s ORDER BY p.market_value DESC LIMIT 1""",
        (household_id, symbol))
    row = cur.fetchone()
    if row is None:
        raise ResetAborted(f"Seed position {symbol} is missing")
    return str(row[0])


def _review_edits(conn, held, latest: dict[str, tuple[str, datetime]]) -> int:
    """A few of Jordan Reyes's edits, so the audit fields have something to show."""
    edits = 0
    with conn.cursor() as cur:
        okafor, okafor_at = latest["sample-okafor"]
        bridge = _position_id(cur, okafor, "BBGLX")
        pipeline_db.update_position_override(
            held, bridge, "LIQUIDATE",
            "Bridge Builder funds can't be held outside Edward Jones. Client agreed to sell at transfer.",
            REVIEWER)
        pipeline_db.set_position_transferring(held, _position_id(cur, okafor, "VTI"), "YES", REVIEWER)
        cur.execute("UPDATE positions SET overridden_at = %s WHERE id = %s", (okafor_at + timedelta(hours=2), bridge))
        cur.execute("UPDATE positions SET transferring_at = %s WHERE transferring = 'YES' AND account_id IN "
                    "(SELECT id FROM accounts WHERE household_id = %s)", (okafor_at + timedelta(hours=2), okafor))
        edits += 2

        reviewed = [latest["sample-lindqvist"]] + [v for k, v in sorted(latest.items())
                                                   if k.startswith("universe-")][:3]
        for household_id, at in reviewed:
            pipeline_db.mark_household_reviewed(held, household_id, REVIEWER)
            cur.execute("UPDATE households SET reviewed_at = %s WHERE id = %s", (at + timedelta(hours=3), household_id))
            edits += 1

        household_id, at = sorted((v for k, v in latest.items() if k.startswith("universe-")), key=lambda v: v[1])[-1]
        cur.execute(
            """SELECT p.id FROM positions p JOIN accounts a ON a.id = p.account_id
               WHERE a.household_id = %s ORDER BY p.market_value ASC LIMIT 1""", (household_id,))
        smallest = str(cur.fetchone()[0])
        pipeline_db.soft_delete_position(held, smallest, REVIEWER)
        cur.execute("UPDATE positions SET deleted_at = %s WHERE id = %s", (at + timedelta(hours=1), smallest))
        edits += 1
    return edits


def reset_demo(conn, now: Optional[datetime] = None, universe: Optional[dict] = None) -> dict:
    """Put the database back to the seed, in one transaction on *conn* (committed here, or rolled back)."""
    started = time.monotonic()
    now = now or datetime.now(ET)
    universe = universe or load_universe()
    plan = seed_plan(universe, now)
    held = _HeldCommits(conn)
    replay = stand_ins.ReplayGenaiClient(stand_ins.answers_for(r.sample for r in plan),
                                         stand_ins.replay_shift_days(now.astimezone(ET).date()))
    restrictions, tickers = stand_ins.DemoRestrictionDB(), stand_ins.DemoTickerDB()
    custodians, apex_rules = stand_ins.DemoCustodianDB(), stand_ins.demo_apex_rules()
    previous_client = ap._genai_client
    ap._genai_client = replay
    # The pipeline logs a failure while seeding a client's destinations and carries on; the reset records it.
    seed_destinations, seed_failures = ap._seed_destination_accounts, []

    def seed_destinations_or_record(*args, **kwargs):
        try:
            return seed_destinations(*args, **kwargs)
        except BaseException as exc:
            seed_failures.append(exc)
            raise
    ap._seed_destination_accounts = seed_destinations_or_record
    # Each run's household gets its key's id (demo_run_id) instead of a random one: the first id write_household
    # draws is the household's, so that one draw is answered with the run's id and every later one is random.
    write_household, real_uuid4 = pipeline_db.write_household, pipeline_db.uuid4

    def write_household_with_run_id(conn_, consolidated, source_folder_id=None):
        run_id = uuid.UUID(demo_run_id(source_folder_id, consolidated.get("run_number", 1)))
        drawn = []

        def uuid4_household_first():
            if drawn:
                return real_uuid4()
            drawn.append(run_id)
            return run_id
        pipeline_db.uuid4 = uuid4_household_first
        try:
            return write_household(conn_, consolidated, source_folder_id)
        finally:
            pipeline_db.uuid4 = real_uuid4
    pipeline_db.write_household = write_household_with_run_id
    try:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE " + ", ".join(_TABLES) + " CASCADE")
        pipeline_db.upsert_personas(held, demo.PERSONAS)
        rows = roster_rows(universe)
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO active_accounts_roster (household, owner, owner_norm, account_type, type_norm,
                   account_title_raw, trading_account_no, apex_number, total_value) VALUES
                   (%s, %s, %s, %s, %s, %s, %s, %s, %s)""", rows)

        latest: dict[str, tuple[str, datetime]] = {}
        for run in plan:
            household_id = ap.process_client_folder(
                drive=None, folder={"id": run.folder_id, "name": run.sample.client_name},
                notion_db=restrictions, custodian_db=custodians, apex_rules_db=apex_rules, ticker_db=tickers,
                db_conn=held, processed_folder_id=None, source=stand_ins.SampleStatementSource(run.sample),
            )
            if not household_id or held.rolled_back or seed_failures:
                raise ResetAborted(f"Seed run {run.sample.key} failed: no household, a rollback, or no destinations")
            with conn.cursor() as cur:
                cur.execute("SELECT run_number FROM households WHERE id = %s", (household_id,))
                (run_number,) = cur.fetchone()
            if str(household_id) != demo_run_id(run.folder_id, run_number):
                raise ResetAborted(f"Seed run {run.sample.key} did not get its run id")
            with conn.cursor() as cur:
                cur.execute("UPDATE households SET processed_at = %s, created_at = %s, updated_at = %s WHERE id = %s",
                            (run.processed_at, run.processed_at, run.processed_at, household_id))
                cur.execute("UPDATE target_accounts SET created_at = %s, updated_at = %s "
                            "WHERE source_folder_id = %s AND created_at > %s",
                            (run.processed_at, run.processed_at, run.folder_id, run.processed_at))
            latest[run.folder_id] = (household_id, run.processed_at)

        edits = _review_edits(conn, held, latest)
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(DISTINCT source_folder_id) FROM target_accounts")
            if cur.fetchone()[0] != len(latest) or held.rolled_back or seed_failures:
                raise ResetAborted("A seeded client has no destination accounts")
            cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE superseded_by IS NULL) FROM households")
            runs, live = cur.fetchone()
            cur.execute("SELECT COUNT(*) FROM positions")
            positions = cur.fetchone()[0]
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        ap._genai_client = previous_client
        ap._seed_destination_accounts = seed_destinations
        pipeline_db.write_household = write_household
    summary = {"runs": runs, "households": live, "positions": positions, "roster": len(rows), "edits": edits,
               "seconds": round(time.monotonic() - started, 1)}
    log.info("Demo reset complete: %s", summary)
    return summary


# ---------------------------------------------------------------------------
# Command line (the deploy, and local runs against the dev branch)
# ---------------------------------------------------------------------------

def direct_url(url: str) -> str:
    """A Neon pooled address's direct host (the host without "-pooler"), for schema changes. Any other address
    is returned as given."""
    parts = urlsplit(url)
    if "-pooler." not in parts.netloc:
        return url
    return urlunsplit(parts._replace(netloc=parts.netloc.replace("-pooler.", ".")))


def main() -> int:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2
    import psycopg2

    schema_conn = psycopg2.connect(direct_url(url))
    try:
        pipeline_db.ensure_schema(schema_conn)
    finally:
        schema_conn.close()
    conn = psycopg2.connect(url)
    try:
        summary = reset_demo(conn)
    finally:
        conn.close()
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
