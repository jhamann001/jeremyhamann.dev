"""Read-only Plaid holdings transferability preview.

Notion is mocked. These tests never call the live restriction database,
and they assert the preview does not write a household or open the pipeline
database.
"""

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import db
import server
from holdings_transferability import (
    classify_plaid_holdings_preview,
    response_leaks_identifier,
)


def _omni(symbol: str) -> dict:
    return {
        "in_notion": True,
        "omni_l_3": "Omni",
        "transferrable": True,
        "override_action": None,
        "override_reason": None,
    }


def _non_omni(symbol: str) -> dict:
    return {
        "in_notion": True,
        "omni_l_3": "Non-Omni",
        "transferrable": False,
        "override_action": "REVIEW",
        "override_reason": "Non-Omni mutual fund — verify transferability",
    }


def _unlisted(symbol: str) -> dict:
    return {
        "in_notion": False,
        "omni_l_3": None,
        "transferrable": None,
        "override_action": None,
        "override_reason": None,
    }


class ClassifyPreviewTests(unittest.TestCase):
    def test_omni_is_likely_transferable_without_echoing_the_ticker(self):
        seen = []

        def query(symbols):
            seen.extend(symbols)

        result = classify_plaid_holdings_preview(
            [{"symbol": "FGHIJ", "name": "Growth Fund", "security_type": "mutual fund"}],
            query_symbols=query,
            check_symbol=_omni,
        )
        self.assertEqual(seen, ["FGHIJ"])
        self.assertEqual(result["rules_status"], "ok")
        self.assertEqual(result["rows"], [{"label": "likely_transferable", "reason": "omni"}])
        self.assertFalse(response_leaks_identifier(result, ["FGHIJ"]))

    def test_non_omni_is_unknown_not_likely_not(self):
        result = classify_plaid_holdings_preview(
            [{"symbol": "FGHIJ", "security_type": "Mutual Fund"}],
            query_symbols=lambda symbols: None,
            check_symbol=_non_omni,
        )
        self.assertEqual(result["rows"], [{"label": "unknown", "reason": "mutual_fund_non_omni"}])
        self.assertNotEqual(result["rows"][0]["label"], "likely_not")

    def test_unlisted_mutual_fund_is_unknown(self):
        result = classify_plaid_holdings_preview(
            [{"symbol": "FGHIJ", "security_type": "mutual fund"}],
            query_symbols=lambda symbols: None,
            check_symbol=_unlisted,
        )
        self.assertEqual(result["rows"], [{"label": "unknown", "reason": "mutual_fund_unlisted"}])

    def test_mutual_fund_ticker_that_does_not_end_in_x_still_uses_security_type(self):
        seen = []
        classify_plaid_holdings_preview(
            [{"symbol": "FGHIJ", "security_type": "mutual fund"}],
            query_symbols=lambda symbols: seen.extend(symbols),
            check_symbol=_omni,
        )
        self.assertEqual(seen, ["FGHIJ"])
        self.assertFalse(seen[0].endswith("X"))

    def test_five_letter_x_ticker_without_security_type_stays_unknown(self):
        def query(symbols):
            raise AssertionError("restriction lookup must not run from the ticker shape")

        result = classify_plaid_holdings_preview(
            [{"symbol": "ABCDEX", "name": "Looks Like a Fund", "security_type": None}],
            query_symbols=query,
            check_symbol=_omni,
        )
        self.assertEqual(result["rows"], [{"label": "unknown", "reason": "missing_security_type"}])

    def test_name_without_ticker_stays_unknown_and_skips_notion(self):
        def query(symbols):
            raise AssertionError("a nameless ticker cannot be looked up")

        result = classify_plaid_holdings_preview(
            [{"symbol": None, "name": "Growth Fund", "security_type": "mutual fund"}],
            query_symbols=query,
            check_symbol=_omni,
        )
        self.assertEqual(result["rows"], [{"label": "unknown", "reason": "missing_symbol"}])

    def test_fixed_income_is_likely_not_without_a_ticker(self):
        result = classify_plaid_holdings_preview(
            [{"symbol": None, "name": "Treasury note", "security_type": "fixed income"}],
        )
        self.assertEqual(result["rows"], [{"label": "likely_not", "reason": "fixed_income"}])

    def test_unsupported_apex_asset_is_likely_not_and_mutual_fund_rule_does_not_preempt_omni(self):
        def apex(asset_type):
            if asset_type == "Equity":
                return {"account_type": "Blocked Equity", "rule_type": "UNSUPPORTED", "notes": "block"}
            if asset_type == "Mutual Fund":
                raise AssertionError("Mutual Fund Companies must not be consulted")
            return None

        result = classify_plaid_holdings_preview(
            [
                {"symbol": "VTI", "security_type": "etf"},
                {"symbol": "FGHIJ", "security_type": "mutual fund"},
            ],
            query_symbols=lambda symbols: None,
            check_symbol=_omni,
            apex_asset_rule=apex,
        )
        # ETF is not Equity, so give the unsupported rule an equity row too.
        equity = classify_plaid_holdings_preview(
            [{"symbol": "IBM", "security_type": "equity"}],
            apex_asset_rule=apex,
        )
        self.assertEqual(equity["rows"], [{"label": "likely_not", "reason": "apex_asset_unsupported"}])
        self.assertEqual(result["rows"][1], {"label": "likely_transferable", "reason": "omni"})

    def test_account_subtype_is_not_invented(self):
        result = classify_plaid_holdings_preview(
            [{
                "symbol": "VTI",
                "security_type": "etf",
                "account_subtype": "inherited ira",
                "cusip": "037833100",
            }],
        )
        self.assertEqual(result["rows"], [{"label": "likely_transferable", "reason": "standard_security"}])
        self.assertFalse(response_leaks_identifier(result, ["VTI"]))

    def test_timeout_marks_every_row_unavailable(self):
        def query(symbols):
            time.sleep(1)

        started = time.monotonic()
        result = classify_plaid_holdings_preview(
            [
                {"symbol": "VTI", "security_type": "etf"},
                {"symbol": "FGHIJ", "security_type": "mutual fund"},
            ],
            query_symbols=query,
            check_symbol=_omni,
            timeout_seconds=0.05,
        )
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(result["rules_status"], "unavailable")
        self.assertEqual(
            result["rows"],
            [
                {"label": "unknown", "reason": "rules_unavailable"},
                {"label": "unknown", "reason": "rules_unavailable"},
            ],
        )

    def test_lookup_exception_marks_every_row_unavailable(self):
        def query(symbols):
            raise RuntimeError("notion down")

        result = classify_plaid_holdings_preview(
            [
                {"symbol": "VTI", "security_type": "equity"},
                {"symbol": "FGHIJ", "security_type": "mutual fund"},
            ],
            query_symbols=query,
            check_symbol=_omni,
        )
        self.assertEqual(result["rules_status"], "unavailable")
        self.assertEqual(len(result["rows"]), 2)
        self.assertTrue(all(row["reason"] == "rules_unavailable" for row in result["rows"]))

    def test_missing_restriction_lookup_marks_every_row_unavailable(self):
        result = classify_plaid_holdings_preview(
            [
                {"symbol": "VTI", "security_type": "etf"},
                {"symbol": "FGHIJ", "security_type": "mutual fund"},
            ],
        )
        self.assertEqual(result["rules_status"], "unavailable")
        self.assertTrue(all(row["reason"] == "rules_unavailable" for row in result["rows"]))

    def test_write_household_is_not_called(self):
        with mock.patch.object(db, "write_household", side_effect=AssertionError("wrote")), \
             mock.patch.object(db, "get_connection", side_effect=AssertionError("opened")):
            result = classify_plaid_holdings_preview(
                [{"symbol": "VTI", "security_type": "etf"}],
            )
        self.assertEqual(result["rows"][0]["label"], "likely_transferable")


class HoldingsTransferabilityRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # One app lifespan: the session manager cannot start twice. A raised
        # init_pool skips the startup connection.
        cls._pool = mock.patch.object(db, "init_pool", side_effect=RuntimeError("no pool in this test"))
        cls._env = mock.patch.dict(os.environ, {"DB_SCHEMA_OWNER": "", "NOTION_TOKEN_KEY": "", "NOTION_DATABASE_ID": ""})
        cls._pool.start()
        cls._env.start()
        cls.client = TestClient(server.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        cls._env.stop()
        cls._pool.stop()

    def setUp(self):
        self.headers = {"Authorization": "Bearer synthetic-token"}

    def test_auth_is_required_and_the_route_does_not_touch_the_database(self):
        with mock.patch.object(db, "get_connection", side_effect=AssertionError("opened")) as opened, \
             mock.patch.object(db, "write_household", side_effect=AssertionError("wrote")) as wrote:
            response = self.client.post("/api/v1/holdings-transferability", json={"rows": []})
        self.assertEqual(response.status_code, 401)
        opened.assert_not_called()
        wrote.assert_not_called()

    def test_preview_returns_labels_without_identifiers_or_writes(self):
        body = {
            "rows": [
                {
                    "symbol": "VTI",
                    "name": "Total Market",
                    "security_type": "etf",
                    "cusip": "037833100",
                    "isin": "US0000000001",
                    "access_token": "secret-token",
                    "cost_basis": 12,
                    "account_subtype": "rollover",
                },
                {"symbol": None, "name": "Treasury", "security_type": "fixed income"},
            ]
        }
        with mock.patch.object(db, "get_connection", side_effect=AssertionError("opened")) as opened, \
             mock.patch.object(db, "write_household", side_effect=AssertionError("wrote")) as wrote, \
             mock.patch.object(server, "_get_apex_rules_db", return_value=None), \
             mock.patch.object(server.pipeline_auth, "verify_positions_api_token", return_value="test-sa"):
            response = self.client.post("/api/v1/holdings-transferability", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["rules_status"], "ok")
        self.assertEqual(payload["rows"][0], {"label": "likely_transferable", "reason": "standard_security"})
        self.assertEqual(payload["rows"][1], {"label": "likely_not", "reason": "fixed_income"})
        encoded = json.dumps(payload)
        for forbidden in ("VTI", "037833100", "US0000000001", "secret-token", "cusip", "isin", "access_token", "cost_basis"):
            self.assertNotIn(forbidden, encoded)
            self.assertNotIn(forbidden.lower(), encoded.lower())
        opened.assert_not_called()
        wrote.assert_not_called()


def _image_sources(dockerfile: str) -> list[str]:
    """Sources copied into the final runtime stage, ignoring the frontend build."""
    stages = []
    current: list[str] = []
    for raw in dockerfile.splitlines():
        line = raw.split("#", 1)[0].strip()
        if line.startswith("FROM "):
            current = []
            stages.append(current)
            continue
        current.append(line)
    sources = []
    for line in stages[-1]:
        if not line.startswith("COPY ") or line.startswith("COPY --from"):
            continue
        parts = line.split()
        sources.extend(parts[1:-1])
    return sources


def _local_imports(path: Path, root: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    modules = set()
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.append(node.module.split(".")[0])
        elif isinstance(node, ast.Import):
            names.extend(alias.name.split(".")[0] for alias in node.names)
        for name in names:
            if (root / f"{name}.py").is_file() or (root / name).is_dir():
                modules.add(name)
    return modules


def _local_server_modules(root: Path) -> set[str]:
    """Every local module the server imports, directly or through another local module."""
    found, pending = set(), ["server"]
    while pending:
        name = pending.pop()
        path = root / f"{name}.py"
        if not path.is_file():
            continue
        for module in _local_imports(path, root) - found:
            found.add(module)
            pending.append(module)
    return found


class ImageContractTests(unittest.TestCase):
    def test_server_imports_are_present_in_the_runtime_image(self):
        root = Path(__file__).resolve().parent
        context = root.parents[1]  # the image builds from the repository root
        sources = _image_sources((root / "Dockerfile").read_text())
        copied = set()
        for source in sources:
            if source.endswith(".py"):
                copied.add(Path(source).stem)
            elif source.endswith("/"):
                copied.add(source.strip("/").split("/")[0])
        missing = _local_server_modules(root) - copied
        self.assertEqual(missing, set())

        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp)
            for source in sources:
                # COPY of several sources into ./ lands each one by its own name.
                src = context / source
                dest = image / Path(source).name
                if src.is_dir():
                    shutil.copytree(src, dest)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dest)
            # The demo needs its data files, not only its modules: the stand-ins read the receiving custodian's
            # rules, and the reset reads the universe (where the Dockerfile's DEMO_UNIVERSE_PATH points).
            probe = subprocess.run(
                [sys.executable, "-c", "import holdings_transferability, stand_ins, demo_reset; "
                 "stand_ins.DemoApexRulesDB(); demo_reset.load_universe()"],
                cwd=image,
                env={**os.environ, "PYTHONPATH": str(image), "DEMO_UNIVERSE_PATH": str(image / "universe.json")},
                capture_output=True,
                text=True,
                timeout=60,
            )
        self.assertEqual(probe.returncode, 0, probe.stderr)


if __name__ == "__main__":
    unittest.main()
