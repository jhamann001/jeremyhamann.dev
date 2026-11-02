"""Regenerates lib/demo/seed/data/statement-runs.json: the Statement Analyzer demo's seed, as AoA's demo seed replays
it into the statement pipeline's stand-in.

It runs the Statement Analyzer's own reset (apps/statements/demo_reset.py) once, offline, against a throwaway
Postgres database, at a fixed clock a few days after the universe's as-of date (so its replay moves no statement date),
then writes every run with its accounts, positions and edits, the destination accounts and the client roster. Times
are kept relative to that clock: a run as business days before the reset and minutes after 9:00 ET (the reset's own
rule), an edit as minutes after its run. Ids are left out; the AoA seed gives every record a stable UUID.

    createdb -h localhost -p 5544 -U aoa statements_snapshot
    python3 -I scripts/demo-statements-snapshot.py ../statements \\
        postgresql://aoa@127.0.0.1:5544/statements_snapshot lib/demo/seed/data/statement-runs.json
    dropdb -h localhost -p 5544 -U aoa statements_snapshot

Run it from apps/aoa with a Python that has apps/statements/requirements.txt installed. The database must be empty and
throwaway: the reset truncates the pipeline's tables. No connection leaves the machine: every socket except a local
one is refused, and the model's answers are the Statement Analyzer's prepared replay.
"""
import json
import os
import socket
import sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
# A Wednesday five days after the universe's as-of date (2026-10-23): the replay's shift is whole weeks, so zero.
CLOCK = datetime(2026, 10, 28, 3, 0, tzinfo=ET)
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def refuse_outside_connections() -> None:
    connect = socket.socket.connect

    def guarded(self, address):
        host = address[0] if isinstance(address, tuple) else address
        if isinstance(host, str) and (host in LOCAL_HOSTS or host.startswith("/")):
            return connect(self, address)
        raise ConnectionRefusedError(f"snapshot: outside connection refused ({host})")

    socket.socket.connect = guarded


def weekdays_before(day: date, earlier: date) -> int:
    """The reset's business-day count: weekdays from `earlier` up to the day before `day`."""
    count, cursor = 0, day
    while cursor > earlier:
        cursor -= timedelta(days=1)
        if cursor.weekday() < 5:
            count += 1
    return count


def month_end_before(d: date) -> date:
    return d.replace(day=1) - timedelta(days=1)


def minutes_between(earlier: datetime, later: datetime) -> int:
    seconds = (later - earlier).total_seconds()
    if seconds % 60:
        raise SystemExit(f"an edit is not on a whole minute after its run: {earlier} → {later}")
    return int(seconds // 60)


def main() -> int:
    statements_app, url, out = sys.argv[1:4]
    refuse_outside_connections()
    sys.path.insert(0, os.path.abspath(statements_app))
    import psycopg2
    import psycopg2.extras
    import db as pipeline_db
    import demo_reset
    import stand_ins
    from reference_data import FUND_RESTRICTIONS
    from samples import SAMPLES_BY_KEY

    if stand_ins.replay_shift_days(CLOCK.date()) != 0:
        raise SystemExit("the clock must fall in the week after the universe's as-of date")
    conn = psycopg2.connect(url)
    pipeline_db.ensure_schema(conn)
    conn.close()
    conn = psycopg2.connect(url)
    summary = demo_reset.reset_demo(conn, now=CLOCK)

    def rows(sql, *params):
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    def number(v):
        return None if v is None else float(v)

    households = rows("SELECT * FROM households ORDER BY processed_at, source_folder_id")
    keys = {h["id"]: f"{h['source_folder_id']}#{h['run_number']}" for h in households}
    sample_periods = {
        f"sample-{key}": {d.period_end.strftime("%m/%d/%Y") for d in sample.documents}
        for key, sample in SAMPLES_BY_KEY.items()
    }

    runs = []
    for h in households:
        at = h["processed_at"].astimezone(ET)
        days = weekdays_before(CLOCK.date(), at.date())
        minutes = minutes_between(datetime(at.year, at.month, at.day, 9, 0, tzinfo=ET), at)
        if demo_reset.business_day_before(CLOCK, days, minutes) != at:
            raise SystemExit(f"run {keys[h['id']]} is not on the reset's business-day rule")

        def after(ts):
            return None if ts is None else minutes_between(at, ts)

        accounts = []
        for a in rows("SELECT * FROM accounts WHERE household_id = %s ORDER BY custodian, account_type, account_number",
                      h["id"]):
            # A sample's own statement keeps its printed date (moved by the replay's weekly shift); an earlier
            # quarter or a generated household's statement is the month that ended before its run.
            stated = a["statement_date"]
            if stated in sample_periods.get(h["source_folder_id"], set()):
                statement = {"printed": stated}
            else:
                lag = next((lag for lag in (4, 0) if month_end_before(at.date() - timedelta(days=lag)).strftime(
                    "%m/%d/%Y") == stated), None)
                if lag is None:
                    raise SystemExit(f"no rule gives {keys[h['id']]}'s statement date {stated}")
                statement = {"monthEndBeforeRun": lag}
            positions = []
            for p in rows("SELECT * FROM positions WHERE account_id = %s "
                          "ORDER BY market_value DESC NULLS LAST, symbol, quantity", a["id"]):
                positions.append({
                    "symbol": p["symbol"], "description": p["description"], "quantity": number(p["quantity"]),
                    "market_value": number(p["market_value"]), "cost_basis": number(p["cost_basis"]),
                    "cost_basis_granularity": p["cost_basis_granularity"], "lots": p["lots"],
                    "asset_type": p["asset_type"], "classification_source": p["classification_source"],
                    "transfer_eligible": p["transfer_eligible"], "transfer_notes": p["transfer_notes"],
                    "original_transfer_eligible": p["original_transfer_eligible"], "notion_check": p["notion_check"],
                    "override_status": p["override_status"], "override_notes": p["override_notes"],
                    "overridden_by": p["overridden_by"], "overridden_after": after(p["overridden_at"]),
                    "transferring": p["transferring"], "transferring_by": p["transferring_by"],
                    "transferring_after": after(p["transferring_at"]),
                    "deleted_by": p["deleted_by"], "deleted_after": after(p["deleted_at"]),
                })
            accounts.append({
                "custodian": a["custodian"], "account_type": a["account_type"], "account_type_raw": a["account_type_raw"],
                "account_type_other": a["account_type_other"], "account_number": a["account_number"],
                "investor_number": a["investor_number"], "account_registration": a["account_registration"],
                "account_holder": a["account_holder"], "statement": statement,
                "cash_balance": number(a["cash_balance"]), "total_value": number(a["total_value"]),
                "cost_basis_status": a["cost_basis_status"], "is_rollover": a["is_rollover"],
                "rollover_note": a["rollover_note"], "is_inherited": a["is_inherited"],
                "inherited_note": a["inherited_note"], "apex_restriction": a["apex_restriction"],
                "apex_special_handling": a["apex_special_handling"], "custodian_intel": a["custodian_intel"],
                "validation_status": a["validation_status"], "validation_issues": a["validation_issues"],
                "deleted_by": a["deleted_by"], "deleted_after": after(a["deleted_at"]),
                "account_type_overridden_by": a["account_type_overridden_by"],
                "account_type_overridden_after": after(a["account_type_overridden_at"]),
                "assets": positions,
            })
        runs.append({
            "key": keys[h["id"]], "source_folder_id": h["source_folder_id"], "client_name": h["client_name"],
            "run_number": h["run_number"], "business_days_before": days, "minutes_after_nine": minutes,
            "superseded_by": keys.get(h["superseded_by"]), "total_value": number(h["total_value"]),
            "docs_total": h["docs_total"], "docs_extracted": h["docs_extracted"], "doc_results": h["doc_results"],
            "reviewed_by": h["reviewed_by"], "reviewed_after": after(h["reviewed_at"]),
            "accounts": accounts,
        })

    destinations = []
    for t in rows("SELECT * FROM target_accounts ORDER BY source_folder_id, owner, target_account_type, created_at"):
        sources = rows("SELECT source_custodian, source_account_number FROM source_account_links "
                       "WHERE target_account_id = %s ORDER BY source_custodian, source_account_number", t["id"])
        destinations.append({
            "source_folder_id": t["source_folder_id"], "owner": t["owner"],
            "target_account_type": t["target_account_type"], "existing_apex_number": t["existing_apex_number"],
            "needs_to_be_opened": t["needs_to_be_opened"],
            "sources": [{"custodian": s["source_custodian"], "account_number": s["source_account_number"]}
                        for s in sources],
        })

    roster = [
        {k: (number(v) if k == "total_value" else v) for k, v in r.items() if k not in ("id", "loaded_at")}
        for r in rows("SELECT * FROM active_accounts_roster ORDER BY ctid")
    ]
    conn.close()

    # Smaller on disk: a custodian's intel is listed once and accounts point at it, and empty fields are left out
    # (the AoA seed puts them back as nulls).
    intel: list = []
    for run in runs:
        for a in run["accounts"]:
            if a["custodian_intel"] is not None:
                if a["custodian_intel"] not in intel:
                    intel.append(a["custodian_intel"])
                a["custodian_intel"] = intel.index(a["custodian_intel"])
            a["assets"] = [{k: v for k, v in p.items() if v is not None} for p in a["assets"]]
        run["accounts"] = [{k: v for k, v in a.items() if v is not None} for a in run["accounts"]]

    snapshot = {
        "about": "The Statement Analyzer demo's seed (apps/statements/demo_reset.py), regenerated by "
                 "scripts/demo-statements-snapshot.py. Every person, account and statement is invented.",
        "clock": CLOCK.isoformat(),
        "summary": summary | {"seconds": None},
        "custodian_intel": intel,
        "runs": runs,
        "destinations": destinations,
        "roster": roster,
        "fund_restrictions": [{"symbol": s, "omni": v.strip().lower().startswith("omni")}
                              for s, v in sorted(FUND_RESTRICTIONS.items())],
    }
    # One record per line: small, and a regeneration diffs by run.
    def compact(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    with open(out, "w", encoding="utf-8") as f:
        f.write("{\n")
        f.write(",\n".join(
            f"{compact(k)}:[\n" + ",\n".join(compact(item) for item in v) + "\n]" if isinstance(v, list)
            else f"{compact(k)}:{compact(v)}"
            for k, v in snapshot.items()))
        f.write("\n}\n")
    print(json.dumps({"runs": len(runs), "destinations": len(destinations), "roster": len(roster),
                      "positions": sum(len(a["assets"]) for r in runs for a in r["accounts"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
