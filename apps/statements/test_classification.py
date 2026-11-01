"""
Regression tests for the deterministic classification engine.

Focused on: Employee Stock Plan accounts must classify as
UNSUPPORTED, not ACAT. Also exercises normalize_account_type,
classify_transfer_eligibility, and _dedup_accounts / _merge_duplicate_accounts.

Run with:

    pytest test_classification.py -v

or plain unittest:

    python -m unittest test_classification.py
"""

import os
import tempfile
import unittest
from unittest import mock

import automation_pipeline as ap
import db as pipeline_db
from automation_pipeline import (
    _map_destination_type,
    _live_open_apex_number,
    _consolidate_lots,
    _dedup_accounts,
    _has_stock_plan_context,
    _infer_apex_rule_scope,
    _is_taxable_account,
    _merge_duplicate_accounts,
    _safe_float_or_none,
    _statement_age_days,
    classify_asset_type,
    classify_document_with_gemini,
    classify_transfer_eligibility,
    detect_cross_account_duplicates,
    doc_classification_bypassed,
    evaluate_doc_gate,
    flag_statement_freshness,
    normalize_account_type,
    statement_stale_days,
    validate_cost_basis,
)


class NormalizeAccountTypeTests(unittest.TestCase):
    def test_etrade_stock_plan_raw_string_normalizes_to_employee_stock_plan(self):
        canonical, is_rollover = normalize_account_type("Stock Plan")
        self.assertEqual(canonical, "Employee Stock Plan")
        self.assertFalse(is_rollover)

    def test_employee_stock_plan_variants(self):
        for raw in (
            "Employee Stock Plan",
            "EMPLOYEE STOCK PLAN",
            "ESPP Account",
            "RSU Account",
            "Restricted Stock Award Account",
        ):
            canonical, _ = normalize_account_type(raw)
            self.assertEqual(
                canonical, "Employee Stock Plan",
                msg=f"raw={raw!r} → {canonical!r}",
            )

    def test_stock_plan_takes_precedence_over_brokerage_keywords(self):
        # "Stock Plan - Individual" should NOT normalize to Individual.
        canonical, _ = normalize_account_type("Stock Plan - Individual")
        self.assertEqual(canonical, "Employee Stock Plan")

    def test_annuity_normalizes_and_is_canonical(self):
        # Annuity must be a recognized account type so the Ops override
        # dropdown selection passes the server's CANONICAL_ACCOUNT_TYPES check.
        from automation_pipeline import CANONICAL_ACCOUNT_TYPES
        for raw in ("Annuity", "Variable Annuity", "Fixed Annuity"):
            canonical, is_rollover = normalize_account_type(raw)
            self.assertEqual(canonical, "Annuity", msg=raw)
            self.assertFalse(is_rollover, msg=raw)
        self.assertIn("Annuity", CANONICAL_ACCOUNT_TYPES)

    def test_standard_individual_brokerage_still_normalizes_individual(self):
        canonical, is_rollover = normalize_account_type("Individual Brokerage")
        self.assertEqual(canonical, "Individual")
        self.assertFalse(is_rollover)


class ClassifyTransferEligibilityTests(unittest.TestCase):
    def _asset(self, symbol="TSLA", asset_type="Equity"):
        return {"symbol": symbol, "type": asset_type}

    def test_employee_stock_plan_equity_is_unsupported(self):
        status, notes = classify_transfer_eligibility(
            asset=self._asset(),
            account_type="Employee Stock Plan",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "UNSUPPORTED")
        self.assertIn("Employee Stock Plan", notes)

    def test_employee_stock_plan_cash_is_also_unsupported(self):
        # Flat UNSUPPORTED, by product decision.
        status, _ = classify_transfer_eligibility(
            asset=self._asset(symbol="", asset_type="Cash"),
            account_type="Employee Stock Plan",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "UNSUPPORTED")

    def test_individual_brokerage_equity_still_acat(self):
        status, _ = classify_transfer_eligibility(
            asset=self._asset(),
            account_type="Individual",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "ACAT")

    def test_apex_account_unsupported_still_wins_for_other_types(self):
        # Layer 1 Apex UNSUPPORTED runs before the stock-plan layer, which
        # matters for Trust/529/HSA accounts that should surface the Notion
        # note verbatim.
        status, notes = classify_transfer_eligibility(
            asset=self._asset(),
            account_type="Trust",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule={
                "rule_type": "UNSUPPORTED",
                "notes": "Trusts are not currently supported at Cedar Ridge Wealth.",
            },
            apex_asset_rule=None,
        )
        self.assertEqual(status, "UNSUPPORTED")
        self.assertIn("Trusts are not currently supported", notes)


class DedupAccountsTests(unittest.TestCase):
    def test_merge_preserves_stock_plan_raw_type(self):
        brokerage = {
            "custodian": "E*TRADE",
            "account_number": "12345678",
            "account_type": "Individual",
            "account_type_raw": "Individual Brokerage",
            "assets": [
                {"symbol": "AAPL", "description": "Apple Inc", "market_value": 1000},
                {"symbol": "MSFT", "description": "Microsoft", "market_value": 2000},
            ],
            "total_value": 3000,
        }
        stock_plan = {
            "custodian": "E*TRADE",
            "account_number": "12345678",
            "account_type": "Employee Stock Plan",
            "account_type_raw": "Employee Stock Plan - Tesla",
            "assets": [
                {"symbol": "TSLA", "description": "Tesla RSU", "market_value": 50000},
            ],
            "total_value": 50000,
        }

        merged = _dedup_accounts([brokerage, stock_plan])

        self.assertEqual(len(merged), 1)
        acct = merged[0]
        self.assertTrue(_has_stock_plan_context(acct["account_type_raw"]))
        self.assertEqual(acct["account_type"], "Employee Stock Plan")
        symbols = {a["symbol"] for a in acct["assets"]}
        self.assertEqual(symbols, {"AAPL", "MSFT", "TSLA"})
        self.assertEqual(acct["total_value"], 50000)

    def test_merge_order_independent(self):
        # Same inputs as above but stock-plan PDF processed first.
        brokerage = {
            "custodian": "E*TRADE",
            "account_number": "12345678",
            "account_type": "Individual",
            "account_type_raw": "Individual Brokerage",
            "assets": [{"symbol": "AAPL", "market_value": 1000}],
            "total_value": 1000,
        }
        stock_plan = {
            "custodian": "E*TRADE",
            "account_number": "12345678",
            "account_type": "Employee Stock Plan",
            "account_type_raw": "Employee Stock Plan",
            "assets": [{"symbol": "TSLA", "market_value": 50000}],
            "total_value": 50000,
        }

        merged = _dedup_accounts([stock_plan, brokerage])
        self.assertEqual(len(merged), 1)
        self.assertTrue(_has_stock_plan_context(merged[0]["account_type_raw"]))

    def test_distinct_account_numbers_are_not_merged(self):
        stock_plan = {
            "custodian": "E*TRADE",
            "account_number": "11111111",
            "account_type_raw": "Employee Stock Plan",
            "assets": [{"symbol": "TSLA", "market_value": 50000}],
        }
        brokerage = {
            "custodian": "E*TRADE",
            "account_number": "22222222",
            "account_type_raw": "Individual Brokerage",
            "assets": [{"symbol": "AAPL", "market_value": 1000}],
        }
        merged = _dedup_accounts([stock_plan, brokerage])
        self.assertEqual(len(merged), 2)

    def test_merge_same_symbol_keeps_larger_market_value(self):
        a = {
            "custodian": "E*TRADE",
            "account_number": "X",
            "account_type_raw": "Stock Plan",
            "assets": [{"symbol": "TSLA", "description": "Tesla", "market_value": 1000}],
        }
        b = {
            "custodian": "E*TRADE",
            "account_number": "X",
            "account_type_raw": "Stock Plan",
            "assets": [{"symbol": "TSLA", "description": "Tesla", "market_value": 5000}],
        }
        merged = _merge_duplicate_accounts(a, b)
        self.assertEqual(len(merged["assets"]), 1)
        self.assertEqual(merged["assets"][0]["market_value"], 5000)


class CashInInvestmentAccountTests(unittest.TestCase):
    """Regression tests: Cash positions inside an investment account must
    route to ACAT, not REVIEW via an account-level Apex rule."""

    def _cash(self, symbol: str = "") -> dict:
        return {"symbol": symbol, "type": "Cash", "description": "Cash"}

    def test_cash_in_ira_is_acat_when_lookup_asset_returns_none(self):
        # Post-fix behavior: lookup_asset("Cash") returns None because the
        # bank rule is scope="account". Caller passes apex_asset_rule=None.
        status, notes = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="IRA",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "ACAT")
        self.assertIn("Cash balance in investment account", notes)

    def test_cash_in_roth_ira_is_acat(self):
        status, _ = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="Roth IRA",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "ACAT")

    def test_cash_in_individual_brokerage_is_acat(self):
        status, _ = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="Individual",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "ACAT")

    def test_cash_in_rollover_401k_still_liquidates(self):
        status, _ = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="401k",
            is_rollover=True,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "LIQUIDATE")

    def test_cash_in_savings_account_still_routes_ach_wire(self):
        # Account-type based Layer 4 handles real bank accounts.
        status, _ = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="Savings",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "ACH/WIRE")

    def test_cash_in_checking_account_still_routes_ach_wire(self):
        status, _ = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="Checking",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "ACH/WIRE")

    def test_cash_in_inherited_ira_still_review(self):
        # Layer 3 (inherited) runs before cash handling; unchanged behavior.
        status, _ = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="Inherited IRA",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "REVIEW")

    def test_cash_in_employee_stock_plan_is_unsupported(self):
        # Layer 1b (stock plan) runs before cash handling; covered already
        # but re-asserted here as a guard.
        status, _ = classify_transfer_eligibility(
            asset=self._cash(),
            account_type="Employee Stock Plan",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "UNSUPPORTED")


class ApexRuleScopeTests(unittest.TestCase):
    """Only rules semantically about securities should match lookup_asset."""

    def test_bank_account_rule_is_account_scope(self):
        self.assertEqual(
            _infer_apex_rule_scope("Checking, Savings, and Cash Accounts"),
            "account",
        )

    def test_trust_rule_is_account_scope(self):
        self.assertEqual(_infer_apex_rule_scope("Trust Accounts"), "account")

    def test_employee_stock_plan_rule_is_account_scope(self):
        self.assertEqual(
            _infer_apex_rule_scope("Employee Stock Plans / RSUs"), "account",
        )

    def test_fixed_income_rule_is_asset_scope(self):
        self.assertEqual(
            _infer_apex_rule_scope("Fixed Income / Bond Accounts"), "asset",
        )

    def test_mutual_fund_companies_rule_is_asset_scope(self):
        self.assertEqual(
            _infer_apex_rule_scope(
                "Mutual Fund Companies (Victory Funds/Capital, T. Rowe Price, First Command)"
            ),
            "asset",
        )

    def test_hedge_funds_rule_is_asset_scope(self):
        self.assertEqual(_infer_apex_rule_scope("Hedge funds"), "asset")


class _StubTickerDB:
    """Minimal stand-in for NotionTickerDB.lookup() in classification tests."""

    def __init__(self, entries: dict[str, dict]):
        self._entries = {k.upper(): v for k, v in entries.items()}

    def lookup(self, symbol: str):
        return self._entries.get((symbol or "").upper())


class PreferredStockClassificationTests(unittest.TestCase):
    def test_reference_types_preserve_preferred_stock(self):
        for raw_type in ("PFD", "PREFERRED STOCK", "Preferred Stock", "PREF", "Preferred Shares"):
            with self.subTest(raw_type=raw_type):
                ticker_db = _StubTickerDB({"DEMO.PR.A": {"asset_type": raw_type}})
                self.assertEqual(
                    classify_asset_type({"symbol": "DEMO.PR.A"}, ticker_db),
                    ("Preferred Stock", "ticker_db"),
                )

    def test_explicit_descriptions_work_with_statement_identifiers(self):
        for symbol in ("DEMO", "DEMO.A", "DEMO/PA", "DEMO PR A", "DEMO-PA", "123456AB7", None):
            for description in (
                "Demo Corp Preferred Stock Series A",
                "Demo Corp 6.25% PFD SER A FLG RATE",
                "Demo Corp PREF. SHS SERIES A",
                "Demo Corp Depositary Shares Representing Preferred Shares Series A",
            ):
                with self.subTest(symbol=symbol, description=description):
                    position = {"symbol": symbol, "description": description}
                    self.assertEqual(classify_asset_type(position), ("Preferred Stock", "heuristic"))
                    self.assertEqual(position, {"symbol": symbol, "description": description})

    def test_preferred_funds_keep_their_fund_classification(self):
        for symbol, description, expected in (
            ("DEMO", "Demo Preferred Stock ETF", "ETF"),
            ("123456AB7", "Demo Preferred Stock ETF", "ETF"),
            (None, "Demo Preferred Stock ETF", "ETF"),
            ("DEMPX", "Demo Preferred Securities Fund", "Mutual Fund"),
            (None, "Demo Preferred Stock Mutual Fund", "Mutual Fund"),
            ("DEMO", "Demo Preferred Stock Income Fund", "Other"),
            (None, "Demo Preferred Stock Private Fund", "Alternative"),
        ):
            with self.subTest(symbol=symbol, description=description):
                self.assertEqual(classify_asset_type({"symbol": symbol, "description": description})[0], expected)

    def test_reference_classification_wins_over_description(self):
        for raw_type, expected in (("ETP", "ETF"), ("CEF", "ETF"), ("Mutual Fund", "Mutual Fund"), ("CS", "Equity")):
            with self.subTest(raw_type=raw_type):
                ticker_db = _StubTickerDB({"DEMO": {"asset_type": raw_type}})
                self.assertEqual(
                    classify_asset_type({"symbol": "DEMO", "description": "Demo Preferred Stock Fund"}, ticker_db),
                    (expected, "ticker_db"),
                )

    def test_common_shares_and_other_instruments_are_not_preferred(self):
        for symbol, description, expected in (
            ("DEMO.A", "Demo Corp Class A", "Equity"),
            ("DEMO/B", "Demo Corp Class B", "Equity"),
            ("DEMO", "Preferred Bank Common Stock", "Equity"),
            ("DEMO", "Demo Corp Preferred Stock Purchase Rights", "Equity"),
            ("DEMO", "Demo Corp Preferred Stock Call Option", "Option"),
            ("123456AB7", "Demo Preferred Stock Linked Note 5.25%", "Fixed Income"),
            ("123456AB7", "Demo Corp Bond 5.25% DUE 2030", "Fixed Income"),
            (None, "Cash Balance", "Cash"),
        ):
            with self.subTest(symbol=symbol, description=description):
                self.assertEqual(classify_asset_type({"symbol": symbol, "description": description})[0], expected)

    def test_mixed_group_does_not_clear_as_equity(self):
        ticker_db = _StubTickerDB({"DEMO.A": {"asset_type": "PFD"}, "DEMO": {"asset_type": "CS"}})
        self.assertEqual(
            classify_asset_type({"symbol": "DEMO.A, DEMO"}, ticker_db),
            ("Other", "multi_ticker"),
        )

    def test_all_preferred_group_retains_type_but_requires_review(self):
        ticker_db = _StubTickerDB({"DEMO.A": {"asset_type": "PFD"}, "DEMO.B": {"asset_type": "PFD"}})
        position = {"symbol": "DEMO.A, DEMO.B"}
        position["type"], position["classification_source"] = classify_asset_type(position, ticker_db)
        self.assertEqual(position["type"], "Preferred Stock")
        status, _ = classify_transfer_eligibility(position, "Individual", False, None, None, None)
        self.assertEqual(status, "REVIEW")


class PreferredStockRoutingTests(unittest.TestCase):
    def route(self, source="ticker_db", symbol="DEMO.A", **overrides):
        args = dict(
            asset={"symbol": symbol, "type": "Preferred Stock", "classification_source": source},
            account_type="Individual", is_rollover=False,
            notion_check=None, apex_acct_rule=None, apex_asset_rule=None,
        )
        args.update(overrides)
        return classify_transfer_eligibility(**args)

    def test_reference_confirmed_preferred_keeps_acat_routing(self):
        status, notes = self.route()
        self.assertEqual(status, "ACAT")
        self.assertIn("Preferred Stock", notes)

    def test_unconfirmed_preferred_requires_review(self):
        for source in ("heuristic", "multi_ticker", None):
            for symbol in ("DEMO.A", "DEMOP", "DEMOQ", "DEMOF", "123456AB7", None):
                with self.subTest(source=source, symbol=symbol):
                    status, notes = self.route(source=source, symbol=symbol)
                    self.assertEqual(status, "REVIEW")
                    self.assertIn("verify", notes.lower())

    def test_account_and_apex_restrictions_still_take_precedence(self):
        for overrides, expected in (
            ({"account_type": "Employee Stock Plan"}, "UNSUPPORTED"),
            ({"account_type": "401k", "is_rollover": True}, "LIQUIDATE"),
            ({"account_type": "Inherited IRA"}, "REVIEW"),
            ({"account_type": "Savings"}, "ACH/WIRE"),
            ({"apex_acct_rule": {"rule_type": "UNSUPPORTED", "notes": "Blocked account"}}, "UNSUPPORTED"),
            ({"apex_asset_rule": {"rule_type": "UNSUPPORTED", "notes": "Blocked asset"}}, "LIQUIDATE"),
            ({"apex_asset_rule": {"rule_type": "SPECIAL HANDLING", "notes": "Check asset"}}, "REVIEW"),
        ):
            with self.subTest(overrides=overrides):
                self.assertEqual(self.route(**overrides)[0], expected)

    def test_account_type_change_preserves_preferred_provenance(self):
        positions = [
            {"id": "confirmed", "symbol": "DEMO.A", "asset_type": "Preferred Stock", "classification_source": "ticker_db"},
            {"id": "unconfirmed", "symbol": "DEMO.B", "asset_type": "Preferred Stock", "classification_source": "heuristic"},
        ]
        _, updates = ap.reclassify_for_new_account_type("Individual", None, positions)
        self.assertEqual([p["transfer_eligible"] for p in updates], ["ACAT", "REVIEW"])

    def test_account_pipeline_classifies_and_routes_both_sources(self):
        ticker_db = _StubTickerDB({"DEMO.A": {"asset_type": "PFD"}})
        ticker_db.query_symbols = mock.Mock()
        notion_db = mock.Mock()
        notion_db.query_cusips.return_value = {}
        account = {
            "account_type": "Individual",
            "assets": [
                {"symbol": "DEMO.A", "description": "Demo Preferred Stock Series A"},
                {"symbol": "123456AB7", "description": "Demo Preferred Stock Series B"},
            ],
        }
        ap._classify_account(account, notion_db, ticker_db, None, None)
        self.assertEqual([p["type"] for p in account["assets"]], ["Preferred Stock", "Preferred Stock"])
        self.assertEqual([p["transfer_eligible"] for p in account["assets"]], ["ACAT", "REVIEW"])


class ClassifyAssetTypeSuffixTests(unittest.TestCase):
    """OTC 5th-character suffix heuristics in classify_asset_type.

    DNNGY incident: an unsponsored Pink Sheet ADR (5-letter Y-suffix) was
    auto-cleared as Equity → ACAT despite not being DTC-eligible. Y-suffix
    tickers without a Notion DB entry must now route to Foreign ADR → REVIEW.
    """

    def _pos(self, symbol: str, description: str = "") -> dict:
        return {"symbol": symbol, "description": description}

    def test_y_suffix_without_ticker_db_classifies_as_foreign_adr(self):
        asset_type, source = classify_asset_type(self._pos("DNNGY"))
        self.assertEqual(asset_type, "Foreign ADR")
        self.assertEqual(source, "heuristic")

    def test_y_suffix_with_ticker_db_entry_still_clears_as_equity(self):
        # Curated sponsored ADR in Notion DB → Tier 1 wins, Y-suffix branch
        # never runs. This is how known DTC-eligible ADRs (BABA, NSRGY, …)
        # continue to auto-clear.
        db = _StubTickerDB({"NSRGY": {"asset_type": "ADR"}})
        asset_type, source = classify_asset_type(self._pos("NSRGY"), ticker_db=db)
        self.assertEqual(asset_type, "Equity")
        self.assertEqual(source, "ticker_db")

    def test_f_suffix_classifies_as_foreign_equity(self):
        asset_type, source = classify_asset_type(self._pos("NSRGF"))
        self.assertEqual(asset_type, "Foreign Equity")
        self.assertEqual(source, "heuristic")

    def test_q_suffix_classifies_as_otc_restricted(self):
        asset_type, _ = classify_asset_type(self._pos("ABCDQ"))
        self.assertEqual(asset_type, "OTC Restricted")

    def test_e_suffix_classifies_as_otc_restricted(self):
        asset_type, _ = classify_asset_type(self._pos("ABCDE"))
        self.assertEqual(asset_type, "OTC Restricted")

    def test_four_letter_y_suffix_is_plain_equity(self):
        # LLY (Eli Lilly): 4 letters, ends in Y, must NOT trigger Foreign ADR.
        asset_type, source = classify_asset_type(self._pos("LLY"))
        self.assertEqual(asset_type, "Equity")
        self.assertEqual(source, "heuristic")

    def test_five_letter_x_suffix_still_classifies_as_mutual_fund(self):
        # Regression: mutual fund branch (line ~1542) runs before OTC
        # suffix branch — VFIAX must stay a Mutual Fund.
        asset_type, _ = classify_asset_type(self._pos("VFIAX"))
        self.assertEqual(asset_type, "Mutual Fund")


class ForeignADRTransferEligibilityTests(unittest.TestCase):
    """Foreign ADR routing in classify_transfer_eligibility (Layer 14a)."""

    def test_foreign_adr_routes_to_review_with_otc_flag_note(self):
        status, notes = classify_transfer_eligibility(
            asset={"symbol": "DNNGY", "type": "Foreign ADR"},
            account_type="Individual",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "REVIEW")
        self.assertIn("DNNGY", notes)
        self.assertIn("OTC Flag", notes)
        self.assertIn("DTC", notes)

    def test_curated_adr_classified_as_equity_still_acat(self):
        # When the ticker DB has confirmed an ADR, classify_asset_type
        # returns "Equity" via Tier 1 — eligibility must still auto-clear.
        status, _ = classify_transfer_eligibility(
            asset={"symbol": "NSRGY", "type": "Equity"},
            account_type="Individual",
            is_rollover=False,
            notion_check=None,
            apex_acct_rule=None,
            apex_asset_rule=None,
        )
        self.assertEqual(status, "ACAT")


class StockPlanContextHelperTests(unittest.TestCase):
    def test_matches_common_phrasings(self):
        for s in (
            "Stock Plan",
            "Employee Stock Plan",
            "ESPP",
            "RSU Vesting Account",
            "Restricted Stock",
        ):
            self.assertTrue(_has_stock_plan_context(s), msg=s)

    def test_ignores_unrelated_strings(self):
        for s in (None, "", "Individual Brokerage", "Traditional IRA", "401(k)"):
            self.assertFalse(_has_stock_plan_context(s), msg=repr(s))


class MultiTickerClassificationTests(unittest.TestCase):
    """Asset-class rows that pack several tickers into one symbol field.

    Robo-advisor statements (e.g. Betterment) group holdings by asset class
    and list multiple ETFs in the symbol field ("VTI, SCHB, VTV"). The combined
    string never matches the single-ticker DB, so historically these fell to
    "Other" → REVIEW. They must now be split, classified per-constituent, and
    cleared only when every constituent is a standard transferable security.
    """

    def _pos(self, symbol: str, description: str = "") -> dict:
        return {"symbol": symbol, "description": description}

    def test_multi_ticker_equity_row_clears_when_all_constituents_equity(self):
        asset_type, source = classify_asset_type(
            self._pos("SPTM, VTV, VTI, SCHB", "U.S. Large Cap Stocks")
        )
        self.assertIn(asset_type, ("Equity", "ETF"))
        self.assertEqual(source, "multi_ticker")

    def test_multi_ticker_equity_row_routes_to_acat(self):
        asset_type, _ = classify_asset_type(
            self._pos("VWO, IEMG", "International Emerging Market Stocks")
        )
        eligibility, _ = classify_transfer_eligibility(
            {"type": asset_type, "symbol": "VWO, IEMG"},
            account_type="Individual", is_rollover=False,
            notion_check=None, apex_acct_rule=None, apex_asset_rule=None,
        )
        self.assertEqual(eligibility, "ACAT")

    def test_multi_ticker_etf_row_via_ticker_db_classifies_as_etf(self):
        db = _StubTickerDB({"MUB": {"asset_type": "ETP"}, "TFI": {"asset_type": "ETP"}})
        asset_type, source = classify_asset_type(
            self._pos("MUB, TFI", "U.S. Municipal Bonds"), ticker_db=db
        )
        self.assertEqual(asset_type, "ETF")
        self.assertEqual(source, "multi_ticker")

    def test_multi_ticker_mixed_constituents_routes_to_review(self):
        # Equity ETF + a mutual fund → not all ETF/Equity → Other → REVIEW.
        asset_type, source = classify_asset_type(self._pos("VTI, VFIAX", ""))
        self.assertEqual(asset_type, "Other")
        self.assertEqual(source, "multi_ticker")
        eligibility, _ = classify_transfer_eligibility(
            {"type": asset_type, "symbol": "VTI, VFIAX"},
            account_type="Individual", is_rollover=False,
            notion_check=None, apex_acct_rule=None, apex_asset_rule=None,
        )
        self.assertEqual(eligibility, "REVIEW")

    def test_single_ticker_unaffected(self):
        # Regression: a plain single ticker must not hit the multi-ticker path.
        asset_type, source = classify_asset_type(self._pos("VOE", "U.S. Mid Cap Stocks"))
        self.assertEqual(asset_type, "Equity")
        self.assertEqual(source, "heuristic")


class BondEtfClassificationTests(unittest.TestCase):
    """Bond ETFs vs individual bonds.

    A clean exchange ticker (1-4 letters) is a listed security that transfers
    in-kind, even if its description says "Bonds" — e.g. the bond ETFs MUB,
    TFI, AGG, BND. A bond-y description must not downgrade a real ticker to
    Fixed Income / LIQUIDATE. Individual bonds (CUSIP or untickered) must still
    classify as Fixed Income.
    """

    def _pos(self, symbol: str, description: str = "") -> dict:
        return {"symbol": symbol, "description": description}

    def test_bond_etf_ticker_classifies_as_equity_not_fixed_income(self):
        asset_type, _ = classify_asset_type(self._pos("MUB", "U.S. Municipal Bonds"))
        self.assertEqual(asset_type, "Equity")
        eligibility, _ = classify_transfer_eligibility(
            {"type": asset_type, "symbol": "MUB"},
            account_type="Individual", is_rollover=False,
            notion_check=None, apex_acct_rule=None, apex_asset_rule=None,
        )
        self.assertEqual(eligibility, "ACAT")

    def test_multi_ticker_bond_etf_row_routes_to_acat(self):
        asset_type, source = classify_asset_type(
            self._pos("MUB, TFI", "U.S. Municipal Bonds")
        )
        self.assertEqual(source, "multi_ticker")
        eligibility, _ = classify_transfer_eligibility(
            {"type": asset_type, "symbol": "MUB, TFI"},
            account_type="Individual", is_rollover=False,
            notion_check=None, apex_acct_rule=None, apex_asset_rule=None,
        )
        self.assertEqual(eligibility, "ACAT")

    def test_individual_bond_cusip_still_fixed_income(self):
        # 9-char CUSIP → individual bond → must still LIQUIDATE.
        asset_type, _ = classify_asset_type(self._pos("912828YK0", "US TREASURY NOTE 2.5% 2026"))
        self.assertEqual(asset_type, "Fixed Income")

    def test_untickered_bond_description_still_fixed_income(self):
        # No ticker, bond description → still Fixed Income.
        asset_type, _ = classify_asset_type(self._pos("", "CORPORATE BOND 4.25% DUE 2030"))
        self.assertEqual(asset_type, "Fixed Income")


class ClassifierThinkingConfigTests(unittest.TestCase):
    """Regression: the pre-extraction classifier must disable thinking on
    gemini-3 (and other thinking) models. Otherwise the thinking budget swallows
    the whole output, the call returns empty (finish_reason=MAX_TOKENS), and the
    except path degrades every doc to doc_type='unknown' — which is not on the
    reject list, silently disabling the reject gate for ALL documents.
    """

    def _classify_capturing_config(self, model_name):
        captured = {}

        class _Resp:
            text = (
                '{"doc_type": "investment_statement", '
                '"statement_date": null, "confidence": "high"}'
            )

        def _fake_generate_content(model, contents, config):
            captured["config"] = config
            return _Resp()

        fake_client = mock.MagicMock()
        fake_client.models.generate_content.side_effect = _fake_generate_content

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(b"%PDF-1.4 dummy bytes for classifier config test")
            tmp_path = tmp.name
        try:
            with mock.patch.object(ap, "_genai_client", fake_client):
                result = classify_document_with_gemini(
                    tmp_path, "application/pdf", model_name
                )
        finally:
            os.unlink(tmp_path)
        return result, captured["config"]

    def test_gemini3_disables_thinking(self):
        result, cfg = self._classify_capturing_config("gemini-3.5-flash")
        # Sanity: the mocked response parsed through cleanly.
        self.assertEqual(result["doc_type"], "investment_statement")
        self.assertIsNotNone(
            cfg.thinking_config,
            "gemini-3 classifier call must set a thinking_config",
        )
        self.assertEqual(cfg.thinking_config.thinking_budget, 0)
        # Headroom so the JSON answer is never truncated.
        self.assertEqual(cfg.max_output_tokens, 512)

    def test_non_thinking_model_leaves_thinking_unset(self):
        _, cfg = self._classify_capturing_config("gemini-1.5-flash")
        self.assertIsNone(cfg.thinking_config)
        self.assertEqual(cfg.max_output_tokens, 512)


class DocGateTests(unittest.TestCase):
    """The pre-extraction gate rejects by DOC TYPE only — staleness is never a
    drop reason (it is flagged, not failed)."""

    def test_reject_type_is_rejected(self):
        decision, reason = evaluate_doc_gate("tax_form", bypass=False)
        self.assertEqual(decision, "reject")
        self.assertIn("tax_form", reason)

    def test_bank_statement_is_rejected(self):
        decision, _ = evaluate_doc_gate("bank_statement", bypass=False)
        self.assertEqual(decision, "reject")

    def test_allowed_statement_processes(self):
        decision, reason = evaluate_doc_gate("investment_statement", bypass=False)
        self.assertEqual(decision, "process")
        self.assertIsNone(reason)

    def test_bypass_overrides_reject(self):
        decision, reason = evaluate_doc_gate("tax_form", bypass=True)
        self.assertEqual(decision, "process")
        self.assertIsNone(reason)

    def test_bypass_flag_reads_env(self):
        for val in ("1", "true", "TRUE", "yes", "on"):
            with mock.patch.dict(os.environ, {"BYPASS_DOC_CLASSIFICATION": val}):
                self.assertTrue(doc_classification_bypassed(), msg=f"val={val!r}")
        for val in ("", "0", "false", "no", "off"):
            with mock.patch.dict(os.environ, {"BYPASS_DOC_CLASSIFICATION": val}):
                self.assertFalse(doc_classification_bypassed(), msg=f"val={val!r}")
        # unset entirely → False
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(doc_classification_bypassed())


class CostBasisReportClassificationTests(unittest.TestCase):
    """Regression: a cost-basis / gain-loss report that lists REAL per-lot
    quantities and market values (e.g. a Merrill "Equity Cost Basis"
    statement) must not be steered into gains_losses just because it's
    titled/framed around cost basis and shows Unrealized Gain/(Loss)
    columns — that would drop real ACAT-eligible holdings via the reject
    gate. The prompt must carve this case out toward investment_statement /
    holdings_report instead.
    """

    def test_prompt_carves_out_holdings_bearing_cost_basis_reports(self):
        prompt = ap._CLASSIFY_DOC_PROMPT
        self.assertRegex(
            prompt,
            r"gains_losses.{0,400}NOT list live per-position quantities",
            msg="gains_losses category must exclude reports with live quantities/market values",
        )
        self.assertIn(
            "NOT gains_losses",
            prompt,
            "prompt must explicitly redirect holdings-bearing cost-basis reports away from gains_losses",
        )

    def test_gains_losses_without_holdings_still_rejected(self):
        # A pure gain/loss summary (no live quantities/market values) should
        # still be rejected — the carve-out is only for holdings-bearing reports.
        decision, reason = evaluate_doc_gate("gains_losses", bypass=False)
        self.assertEqual(decision, "reject")
        self.assertIn("gains_losses", reason)

    def test_holdings_report_type_processes(self):
        # A cost-basis report correctly reclassified to holdings_report (real
        # positions, quantities, and market values) must pass the gate.
        decision, reason = evaluate_doc_gate("holdings_report", bypass=False)
        self.assertEqual(decision, "process")
        self.assertIsNone(reason)


class StatementFreshnessTests(unittest.TestCase):
    """Stale statements are flagged (statement_age_days / is_stale), not dropped."""

    STALE_DATE = "2000-01-01"  # always far older than any threshold

    def test_age_days_parses_formats(self):
        self.assertIsNone(_statement_age_days(None))
        self.assertIsNone(_statement_age_days("not a date"))
        self.assertGreater(_statement_age_days(self.STALE_DATE), 9000)
        for fmt in ("2000-01-01", "01/01/2000", "01-01-2000", "January 1, 2000", "Jan 1, 2000"):
            self.assertGreater(_statement_age_days(fmt), 9000, fmt)

    def test_age_days_parses_statement_period_ranges(self):
        # Ranges use the period END date; all of these are years old.
        for rng in ("February 1-28, 2000", "February 1 - 28, 2000",
                    "January 1 - February 28, 2000", "01/01/2000 - 01/31/2000"):
            age = _statement_age_days(rng)
            self.assertIsNotNone(age, rng)
            self.assertGreater(age, 9000, rng)

    def test_old_statement_flagged_stale(self):
        acct = {"statement_date": self.STALE_DATE}
        age = flag_statement_freshness(acct, stale_days=60)
        self.assertTrue(acct["is_stale"])
        self.assertEqual(acct["statement_age_days"], age)
        self.assertGreater(age, 60)

    def test_missing_date_not_stale(self):
        acct = {"statement_date": None}
        flag_statement_freshness(acct, stale_days=60)
        self.assertFalse(acct["is_stale"])
        self.assertIsNone(acct["statement_age_days"])

    def test_threshold_boundary_inclusive(self):
        # age == threshold is NOT stale; age > threshold is stale
        acct = {"statement_date": self.STALE_DATE}
        big = _statement_age_days(self.STALE_DATE)
        flag_statement_freshness(acct, stale_days=big)
        self.assertFalse(acct["is_stale"])
        flag_statement_freshness(acct, stale_days=big - 1)
        self.assertTrue(acct["is_stale"])

    def test_stale_days_reads_env_default_60(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(statement_stale_days(), 60)
        with mock.patch.dict(os.environ, {"STATEMENT_STALE_DAYS": "90"}):
            self.assertEqual(statement_stale_days(), 90)
        with mock.patch.dict(os.environ, {"STATEMENT_STALE_DAYS": "garbage"}):
            self.assertEqual(statement_stale_days(), 60)


class SafeFloatOrNoneTests(unittest.TestCase):
    def test_none_stays_none(self):
        self.assertIsNone(_safe_float_or_none(None))

    def test_blank_string_stays_none(self):
        self.assertIsNone(_safe_float_or_none(""))
        self.assertIsNone(_safe_float_or_none("   "))

    def test_zero_is_preserved_not_none(self):
        # A real $0 must stay 0.0 — distinct from "not provided".
        self.assertEqual(_safe_float_or_none(0), 0.0)
        self.assertEqual(_safe_float_or_none("0"), 0.0)

    def test_currency_string_parsed(self):
        self.assertEqual(_safe_float_or_none("$1,234.56"), 1234.56)

    def test_unparseable_stays_none(self):
        self.assertIsNone(_safe_float_or_none("n/a"))


class ConsolidateLotsCostBasisTests(unittest.TestCase):
    def test_position_level_basis_preserved_no_lots(self):
        out = _consolidate_lots([
            {"symbol": "VTI", "quantity": 300, "market_value": 82140, "cost_basis": 61000},
        ])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["cost_basis"], 61000)
        self.assertEqual(out[0]["lots"], [])

    def test_lot_detail_preserved_and_summed(self):
        out = _consolidate_lots([
            {
                "symbol": "AAPL", "quantity": 300, "market_value": 59100,
                "lots": [
                    {"acquisition_date": "2019-03-15", "quantity": 200, "cost_basis": 9800, "market_value": 39400},
                    {"acquisition_date": "2024-02-10", "quantity": 100, "cost_basis": 10500, "market_value": 19700},
                ],
            },
        ])
        self.assertEqual(len(out), 1)
        self.assertEqual(len(out[0]["lots"]), 2)
        # No explicit top-level basis → summed from lots.
        self.assertEqual(out[0]["cost_basis"], 20300)

    def test_explicit_total_basis_preferred_over_lot_sum(self):
        out = _consolidate_lots([
            {
                "symbol": "AAPL", "quantity": 300, "market_value": 59100, "cost_basis": 20300,
                "lots": [
                    {"acquisition_date": "2019-03-15", "quantity": 200, "cost_basis": 9800, "market_value": 39400},
                    {"acquisition_date": "2024-02-10", "quantity": 100, "cost_basis": 10500, "market_value": 19700},
                ],
            },
        ])
        self.assertEqual(out[0]["cost_basis"], 20300)

    def test_missing_lot_basis_nulls_position_total(self):
        # If ANY lot lacks basis and there's no explicit total, total is unknown.
        out = _consolidate_lots([
            {
                "symbol": "AAPL", "quantity": 300, "market_value": 59100,
                "lots": [
                    {"acquisition_date": "2019-03-15", "quantity": 200, "cost_basis": 9800, "market_value": 39400},
                    {"acquisition_date": "2024-02-10", "quantity": 100, "cost_basis": None, "market_value": 19700},
                ],
            },
        ])
        self.assertIsNone(out[0]["cost_basis"])

    def test_no_basis_at_all_is_none(self):
        out = _consolidate_lots([
            {"symbol": "GE", "quantity": 40, "market_value": 6800},
        ])
        self.assertIsNone(out[0]["cost_basis"])
        self.assertEqual(out[0]["lots"], [])

    def test_summary_row_with_separate_lot_rows_folds_lots(self):
        # Legacy shape: a summary row plus flat per-lot rows for the same symbol.
        out = _consolidate_lots([
            {"symbol": "MSFT", "quantity": 300, "market_value": 120000, "cost_basis": 70000},
            {"symbol": "MSFT", "quantity": 200, "market_value": 80000, "cost_basis": 50000, "acquisition_date": "2020-01-01"},
            {"symbol": "MSFT", "quantity": 100, "market_value": 40000, "cost_basis": 20000, "acquisition_date": "2023-01-01"},
        ])
        self.assertEqual(len(out), 1)
        # Summary row (120000 ≈ 80000 + 40000) wins for market value.
        self.assertEqual(out[0]["market_value"], 120000)
        self.assertEqual(out[0]["cost_basis"], 70000)
        # The two lot rows are folded into lot detail.
        self.assertEqual(len(out[0]["lots"]), 2)


class ReclassifyOtherLabelTests(unittest.TestCase):
    def test_other_label_kept_for_other_type(self):
        fields, _ = ap.reclassify_for_new_account_type(
            "Other", apex_rules_db=None, positions=[],
            account_type_other="Donor-Advised Fund",
        )
        self.assertEqual(fields["account_type"], "Other")
        self.assertEqual(fields["account_type_other"], "Donor-Advised Fund")

    def test_other_label_cleared_for_named_type(self):
        # Switching to a named type must drop any stale free-text label.
        fields, _ = ap.reclassify_for_new_account_type(
            "Individual", apex_rules_db=None, positions=[],
            account_type_other="Donor-Advised Fund",
        )
        self.assertIsNone(fields["account_type_other"])

    def test_blank_other_label_normalized_to_none(self):
        fields, _ = ap.reclassify_for_new_account_type(
            "Other", apex_rules_db=None, positions=[],
            account_type_other="   ",
        )
        self.assertIsNone(fields["account_type_other"])

    def test_other_label_does_not_change_eligibility(self):
        # The label is informational; an Other account routes by asset rules.
        positions = [{"id": "1", "symbol": "AAPL", "asset_type": "Equity"}]
        _, updates = ap.reclassify_for_new_account_type(
            "Other", apex_rules_db=None, positions=positions,
            account_type_other="Some Weird Account",
        )
        self.assertEqual(updates[0]["transfer_eligible"], "ACAT")


class IsTaxableAccountTests(unittest.TestCase):
    def test_individual_is_taxable(self):
        self.assertTrue(_is_taxable_account({"account_type": "Individual"}))

    def test_joint_and_trust_and_custodial_taxable(self):
        for t in ("Joint", "Trust", "Custodial", "CMA"):
            self.assertTrue(_is_taxable_account({"account_type": t}), msg=t)

    def test_iras_and_retirement_not_taxable(self):
        for t in ("IRA", "Roth IRA", "401k", "403b", "SEP IRA", "529", "TSP"):
            self.assertFalse(_is_taxable_account({"account_type": t}), msg=t)

    def test_bank_accounts_not_taxable(self):
        for t in ("Savings", "Checking"):
            self.assertFalse(_is_taxable_account({"account_type": t}), msg=t)

    def test_falls_back_to_raw_type(self):
        self.assertTrue(_is_taxable_account({"account_type_raw": "Individual Brokerage"}))
        self.assertFalse(_is_taxable_account({"account_type_raw": "Roth IRA"}))


class ValidateCostBasisTests(unittest.TestCase):
    def _taxable(self, assets):
        return {"account_type": "Individual", "assets": assets}

    def test_complete_when_all_have_basis(self):
        status, issues = validate_cost_basis(self._taxable([
            {"symbol": "VTI", "market_value": 100, "cost_basis": 80, "lots": []},
            {"symbol": "AAPL", "market_value": 200, "cost_basis": 120, "lots": []},
        ]))
        self.assertEqual(status, "COMPLETE")
        self.assertFalse(issues)

    def test_partial_when_some_missing(self):
        status, issues = validate_cost_basis(self._taxable([
            {"symbol": "VTI", "market_value": 100, "cost_basis": 80, "lots": []},
            {"symbol": "GE", "market_value": 50, "cost_basis": None, "lots": []},
        ]))
        self.assertEqual(status, "PARTIAL")
        self.assertTrue(any("GE" in i for i in issues))

    def test_missing_when_none_have_basis(self):
        status, _ = validate_cost_basis(self._taxable([
            {"symbol": "VTI", "market_value": 100, "cost_basis": None, "lots": []},
            {"symbol": "GE", "market_value": 50, "cost_basis": None, "lots": []},
        ]))
        self.assertEqual(status, "MISSING")

    def test_cash_excluded_from_coverage(self):
        # Cash never needs basis; an account of only-basis securities + cash is COMPLETE.
        status, _ = validate_cost_basis(self._taxable([
            {"symbol": "VTI", "market_value": 100, "cost_basis": 80, "lots": []},
            {"symbol": "CASH", "description": "Cash Balance", "market_value": 25, "cost_basis": None, "lots": []},
        ]))
        self.assertEqual(status, "COMPLETE")

    def test_tax_advantaged_is_not_applicable(self):
        status, _ = validate_cost_basis({
            "account_type": "Roth IRA",
            "assets": [{"symbol": "VTI", "market_value": 100, "cost_basis": None, "lots": []}],
        })
        self.assertEqual(status, "NOT_APPLICABLE")

    def test_granularity_tagging(self):
        acct = self._taxable([
            {"symbol": "AAPL", "market_value": 200, "cost_basis": 120,
             "lots": [{"acquisition_date": "2020-01-01", "quantity": 10, "cost_basis": 120, "market_value": 200}]},
            {"symbol": "VTI", "market_value": 100, "cost_basis": 80, "lots": []},
            {"symbol": "GE", "market_value": 50, "cost_basis": None, "lots": []},
        ])
        validate_cost_basis(acct)
        gran = {p["symbol"]: p["cost_basis_granularity"] for p in acct["assets"]}
        self.assertEqual(gran["AAPL"], "lot")
        self.assertEqual(gran["VTI"], "position")
        self.assertIsNone(gran["GE"])

    def test_lot_vs_total_mismatch_flagged(self):
        status, issues = validate_cost_basis(self._taxable([
            {"symbol": "AAPL", "market_value": 200, "cost_basis": 120,
             "lots": [
                 {"acquisition_date": "2020-01-01", "quantity": 10, "cost_basis": 50, "market_value": 100},
                 {"acquisition_date": "2021-01-01", "quantity": 10, "cost_basis": 50, "market_value": 100},
             ]},
        ]))
        # lot sum (100) vs explicit total (120) differ by >2% → mismatch issue.
        self.assertTrue(any("mismatch" in i.lower() for i in issues))

    def test_does_not_touch_transfer_eligibility(self):
        acct = self._taxable([
            {"symbol": "GE", "market_value": 50, "cost_basis": None, "lots": [],
             "transfer_eligible": "ACAT"},
        ])
        validate_cost_basis(acct)
        self.assertEqual(acct["assets"][0]["transfer_eligible"], "ACAT")


class DestinationMatchingTests(unittest.TestCase):
    """Owner/type normalization + destination-type mapping for the
    Accounts-to-be-opened suggestion engine."""

    def test_owner_norm_drops_middle_initial_and_punctuation(self):
        # 'KOFI M OKAFOR-ALVAREZ' and 'Kofi Okafor-Alvarez' must collide
        self.assertEqual(
            pipeline_db.normalize_owner("KOFI M OKAFOR-ALVAREZ"),
            pipeline_db.normalize_owner("Kofi Okafor-Alvarez"),
        )
        self.assertEqual(pipeline_db.normalize_owner("Lucia  Alvarez"), "lucia alvarez")

    def test_acct_type_norm_collapses_vocabularies(self):
        n = pipeline_db.normalize_acct_type
        self.assertEqual(n("Traditional IRA"), "TRAD IRA")
        self.assertEqual(n("Traditional_Ira"), "TRAD IRA")
        self.assertEqual(n("Roth_Ira"), "ROTH IRA")
        self.assertEqual(n("Brokerage"), "INDIVIDUAL")
        self.assertEqual(n("Brokerage Companion"), "INDIVIDUAL")          # Companion stripped
        self.assertEqual(n("Joint Brokerage Tenants With Right Of Survivorship"), "JOINT")
        self.assertEqual(n("Joint Brokerage Tenants In Common"), "JOINT")
        self.assertEqual(n("Traditional_Ira_Inherited"), "TRAD IRA INHERITED")

    def test_acct_type_norm_aligns_warehouse_and_roster_spellings(self):
        # Warehouse 'TRADITIONAL_IRA' and roster 'Traditional IRA' -> same bucket
        self.assertEqual(
            pipeline_db.normalize_acct_type("TRADITIONAL_IRA"),
            pipeline_db.normalize_acct_type("Traditional IRA"),
        )

    def test_destination_type_map(self):
        self.assertEqual(_map_destination_type("401k"), "Traditional IRA")
        self.assertEqual(_map_destination_type("Rollover IRA"), "Traditional IRA")
        self.assertEqual(_map_destination_type("Roth IRA"), "Roth IRA")
        self.assertEqual(_map_destination_type("Joint"), "Joint")
        self.assertEqual(_map_destination_type("Individual Brokerage"), "Individual")


class _StubWarehouseClient:
    """Records the (first, last) it was asked about, standing in for
    WarehouseClient.open_accounts_by_name.

    Pass `rows` to return the same canned rows for any name, or `rows_by_name`
    (keyed by (first, last)) to return different rows per participant."""

    def __init__(self, rows=None, rows_by_name=None):
        self._rows = rows
        self._by_name = rows_by_name or {}
        self.calls = []

    def open_accounts_by_name(self, first_name, last_name):
        self.calls.append((first_name, last_name))
        if self._rows is not None:
            return list(self._rows)
        return list(self._by_name.get((first_name, last_name), []))


class LiveOpenApexNumberTests(unittest.TestCase):
    """When the roster misses a client, the warehouse is consulted so an open Apex account isn't flagged
    'needs to be opened'."""

    def test_open_roth_ira_is_found_by_name_and_type(self):
        # A roster that omits an open account: Ken Nakamura has an OPEN Roth IRA (DEMO-310455) that the
        # roster feed left out. The live lookup returns its Apex number.
        mb = _StubWarehouseClient([
            {"account_type": "ROTH_IRA", "custodian_account_number": "DEMO-310455"},
        ])
        self.assertEqual(
            _live_open_apex_number(mb, "Ken Nakamura", pipeline_db.normalize_acct_type("Roth IRA")),
            "DEMO-310455",
        )
        self.assertEqual(mb.calls, [("Ken", "Nakamura")])

    def test_type_must_match(self):
        # An open Traditional IRA does not satisfy a Roth IRA destination.
        mb = _StubWarehouseClient([
            {"account_type": "TRADITIONAL_IRA", "custodian_account_number": "T1234"},
        ])
        self.assertIsNone(
            _live_open_apex_number(mb, "Ken Nakamura", pipeline_db.normalize_acct_type("Roth IRA")),
        )

    def test_last_token_used_for_hyphenated_and_middle_names(self):
        mb = _StubWarehouseClient([
            {"account_type": "INDIVIDUAL", "custodian_account_number": "I9"},
        ])
        _live_open_apex_number(mb, "Kofi M Okafor-Alvarez",
                               pipeline_db.normalize_acct_type("Individual"))
        self.assertEqual(mb.calls, [("Kofi", "Okafor-Alvarez")])

    def test_no_match_returns_none(self):
        mb = _StubWarehouseClient([])
        self.assertIsNone(
            _live_open_apex_number(mb, "Ken Nakamura", pipeline_db.normalize_acct_type("Roth IRA")),
        )

    def test_row_without_apex_number_is_ignored(self):
        mb = _StubWarehouseClient([
            {"account_type": "ROTH_IRA", "custodian_account_number": None},
        ])
        self.assertIsNone(
            _live_open_apex_number(mb, "Ken Nakamura", pipeline_db.normalize_acct_type("Roth IRA")),
        )

    def test_joint_resolved_via_first_named_participant(self):
        # "A & B" where both have full names: query the first participant; the
        # warehouse returns the shared joint account.
        mb = _StubWarehouseClient(rows_by_name={
            ("Grace", "Chen"): [
                {"account_type": "JOINT_BROKERAGE_TENANTS_WITH_RIGHT_OF_SURVIVORSHIP",
                 "custodian_account_number": "DEMO-310462"},
            ],
        })
        self.assertEqual(
            _live_open_apex_number(mb, "Grace Chen & Ravi Patel",
                                   pipeline_db.normalize_acct_type("Joint")),
            "DEMO-310462",
        )
        self.assertEqual(mb.calls, [("Grace", "Chen")])

    def test_joint_shared_surname_falls_through_to_second_participant(self):
        # "John & Owen Ashby": first participant "John" has no surname to query, so
        # the lookup skips it and resolves via "Owen Ashby".
        mb = _StubWarehouseClient(rows_by_name={
            ("Owen", "Ashby"): [{"account_type": "JOINT", "custodian_account_number": "J1"}],
        })
        self.assertEqual(
            _live_open_apex_number(mb, "John & Owen Ashby", pipeline_db.normalize_acct_type("Joint")),
            "J1",
        )
        self.assertEqual(mb.calls, [("Owen", "Ashby")])  # "John" never queried

    def test_no_client_or_single_token_name_returns_none(self):
        mb = _StubWarehouseClient([
            {"account_type": "ROTH_IRA", "custodian_account_number": "DEMO-310455"},
        ])
        self.assertIsNone(_live_open_apex_number(None, "Ken Nakamura", "ROTH IRA"))
        self.assertIsNone(_live_open_apex_number(mb, "Cher", "ROTH IRA"))
        self.assertEqual(mb.calls, [])


class BulkQueryBoundsTests(unittest.TestCase):
    """Pure pagination helper for the bulk /api/v1/households machine read."""

    def test_defaults_first_page(self):
        self.assertEqual(pipeline_db.bulk_query_bounds(1, 100, 200), (1, 100, 0))

    def test_offset_scales_with_page(self):
        self.assertEqual(pipeline_db.bulk_query_bounds(3, 50, 200), (3, 50, 100))

    def test_per_page_clamped_to_max(self):
        # per_page over the cap is clamped; offset uses the clamped value.
        self.assertEqual(pipeline_db.bulk_query_bounds(2, 1000, 200), (2, 200, 200))

    def test_page_floors_at_one(self):
        self.assertEqual(pipeline_db.bulk_query_bounds(0, 100, 200), (1, 100, 0))
        self.assertEqual(pipeline_db.bulk_query_bounds(-5, 100, 200), (1, 100, 0))

    def test_per_page_floors_at_one(self):
        self.assertEqual(pipeline_db.bulk_query_bounds(1, 0, 200), (1, 1, 0))

    def test_none_inputs_fall_back_to_defaults(self):
        self.assertEqual(pipeline_db.bulk_query_bounds(None, None, 200), (1, 1, 0))

    def test_string_inputs_are_coerced(self):
        self.assertEqual(pipeline_db.bulk_query_bounds("2", "25", 200), (2, 25, 25))


class AssembleHouseholdTreeTests(unittest.TestCase):
    """Pure grouping for the bulk read: households -> accounts[] -> assets[]."""

    def _fixture(self):
        households = [
            {"id": "h1", "client_name": "Alpha", "superseded_by": None},
            {"id": "h2", "client_name": "Beta", "superseded_by": None},
        ]
        accounts = [
            {"id": "a1", "household_id": "h1", "account_number": "12345678"},
            {"id": "a2", "household_id": "h1", "account_number": "87654321"},
            {"id": "a3", "household_id": "h2", "account_number": "99999999"},
        ]
        positions = [
            {"id": "p1", "account_id": "a1", "symbol": "AAPL"},
            {"id": "p2", "account_id": "a1", "symbol": "MSFT"},
            {"id": "p3", "account_id": "a3", "symbol": "TSLA"},
        ]
        return households, accounts, positions

    def test_full_tree_shape(self):
        tree = pipeline_db.assemble_household_tree(*self._fixture())
        self.assertEqual([h["id"] for h in tree], ["h1", "h2"])
        h1, h2 = tree
        self.assertEqual([a["id"] for a in h1["accounts"]], ["a1", "a2"])
        self.assertEqual([p["symbol"] for p in h1["accounts"][0]["assets"]], ["AAPL", "MSFT"])
        # account with no positions still gets an empty assets list.
        self.assertEqual(h1["accounts"][1]["assets"], [])
        self.assertEqual([a["id"] for a in h2["accounts"]], ["a3"])
        self.assertEqual([p["symbol"] for p in h2["accounts"][0]["assets"]], ["TSLA"])

    def test_account_numbers_are_unmasked(self):
        tree = pipeline_db.assemble_household_tree(*self._fixture())
        numbers = [a["account_number"] for h in tree for a in h["accounts"]]
        self.assertIn("12345678", numbers)  # raw, not bulleted/masked
        self.assertFalse(any("•" in n for n in numbers))

    def test_household_with_no_accounts_gets_empty_list(self):
        households = [{"id": "h9", "client_name": "Gamma"}]
        tree = pipeline_db.assemble_household_tree(households, [], [])
        self.assertEqual(tree[0]["accounts"], [])

    def test_inputs_not_mutated(self):
        households, accounts, positions = self._fixture()
        pipeline_db.assemble_household_tree(households, accounts, positions)
        self.assertNotIn("accounts", households[0])
        self.assertNotIn("assets", accounts[0])

    def test_id_coercion_matches_across_types(self):
        # Serialized rows carry string ids, but be resilient if an int slips in.
        households = [{"id": 1}]
        accounts = [{"id": 10, "household_id": 1}]
        positions = [{"id": 100, "account_id": 10}]
        tree = pipeline_db.assemble_household_tree(households, accounts, positions)
        self.assertEqual(len(tree[0]["accounts"][0]["assets"]), 1)


class CrossAccountDuplicateTests(unittest.TestCase):
    """Regression: T. Rowe Price mutual-fund statements group several
    registrations (e.g. Roth IRA + Rollover IRA) under ONE investor number
    with NO per-account number. The extractor duplicated the whole portfolio
    into both registrations (and read a stale prior-period column), so each
    account listed all six funds. Per-account validate_extraction can't see
    this — only detect_cross_account_duplicates, which compares across the
    sibling accounts, can.

    The numbers are invented (investor DEMOINV1, period ending 3/31/26):
    portfolio total $140,000.00, split $93,965.00 Roth / $46,035.00 Rollover.
    """

    # The six funds with their correct 3/31 (current period) market values.
    ALL_SIX = [
        {"symbol": "PRGFX", "market_value": 41250.00},
        {"symbol": "PRWCX", "market_value": 36880.00},
        {"symbol": "PRFDX", "market_value": 18420.00},
        {"symbol": "TRBCX", "market_value": 27615.00},
        {"symbol": "PRNHX", "market_value": 12330.00},
        {"symbol": "PRRXX", "market_value": 3505.00},
    ]

    def _acat(self, rows):
        return [dict(r, transfer_eligible="ACAT") for r in rows]

    def _duplicated_extraction(self):
        # What the buggy mapping produced: BOTH registrations carry all six
        # funds, and each reports the whole (stale, prior-period) portfolio
        # as its own total.
        return [
            {"custodian": "T. Rowe Price", "account_number": None,
             "investor_number": "DEMOINV1", "account_registration": "Roth IRA",
             "statement_portfolio_total": 140000.00, "total_value": 138600.00,
             "assets": self._acat(self.ALL_SIX)},
            {"custodian": "T. Rowe Price", "account_number": None,
             "investor_number": "DEMOINV1", "account_registration": "Rollover IRA",
             "statement_portfolio_total": 140000.00, "total_value": 138600.00,
             "assets": self._acat(self.ALL_SIX)},
        ]

    def _correct_split(self):
        roth = self._acat([
            {"symbol": "PRGFX", "market_value": 41250.00},
            {"symbol": "PRWCX", "market_value": 36880.00},
            {"symbol": "PRNHX", "market_value": 12330.00},
            {"symbol": "PRRXX", "market_value": 3505.00},
        ])
        rollover = self._acat([
            {"symbol": "PRFDX", "market_value": 18420.00},
            {"symbol": "TRBCX", "market_value": 27615.00},
        ])
        return [
            {"custodian": "T. Rowe Price", "account_number": None,
             "investor_number": "DEMOINV1", "account_registration": "Roth IRA",
             "statement_portfolio_total": 140000.00, "total_value": 93965.00,
             "assets": roth},
            {"custodian": "T. Rowe Price", "account_number": None,
             "investor_number": "DEMOINV1", "account_registration": "Rollover IRA",
             "statement_portfolio_total": 140000.00, "total_value": 46035.00,
             "assets": rollover},
        ]

    def test_duplicated_portfolio_is_flagged_and_forced_review(self):
        accts = self._duplicated_extraction()
        findings = detect_cross_account_duplicates(accts)
        self.assertTrue(findings)
        for a in accts:
            self.assertEqual(a["validation_status"], "WARNING")
            self.assertTrue(any("Duplicate holding" in i for i in a["validation_issues"]))
            for pos in a["assets"]:
                self.assertEqual(pos["transfer_eligible"], "REVIEW")
                self.assertEqual(pos["original_transfer_eligible"], "ACAT")

    def test_duplicate_finding_names_the_shared_ticker(self):
        findings = detect_cross_account_duplicates(self._duplicated_extraction())
        self.assertIn("PRGFX", " ".join(findings))

    def test_portfolio_total_overage_is_flagged(self):
        # 138,600 + 138,600 = 277,200 > 140,000 → overage finding.
        findings = detect_cross_account_duplicates(self._duplicated_extraction())
        self.assertTrue(any("portfolio total" in f for f in findings))

    def test_correct_split_is_not_flagged(self):
        accts = self._correct_split()
        self.assertEqual(detect_cross_account_duplicates(accts), [])
        for a in accts:
            self.assertNotEqual(a.get("validation_status"), "WARNING")
            for pos in a["assets"]:
                self.assertEqual(pos["transfer_eligible"], "ACAT")

    def test_zero_value_cash_shared_across_accounts_is_not_a_duplicate(self):
        # A $0 sweep with the same ticker can appear in both accounts legitimately.
        accts = [
            {"total_value": 5000.00, "assets": self._acat(
                [{"symbol": "PRRXX", "market_value": 0.0}, {"symbol": "AAA", "market_value": 5000.00}])},
            {"total_value": 7500.00, "assets": self._acat(
                [{"symbol": "PRRXX", "market_value": 0.0}, {"symbol": "BBB", "market_value": 7500.00}])},
        ]
        self.assertEqual(detect_cross_account_duplicates(accts), [])

    def test_same_ticker_at_different_values_is_not_a_duplicate(self):
        # Two genuinely different accounts can both hold AAPL at different sizes;
        # only near-equal values signal a copied holding. Totals within budget.
        accts = [
            {"total_value": 10000.00, "statement_portfolio_total": 35000.00,
             "assets": self._acat([{"symbol": "AAPL", "market_value": 10000.00}])},
            {"total_value": 25000.00, "statement_portfolio_total": 35000.00,
             "assets": self._acat([{"symbol": "AAPL", "market_value": 25000.00}])},
        ]
        self.assertEqual(detect_cross_account_duplicates(accts), [])

    def test_single_account_is_a_noop(self):
        accts = [{"total_value": 1000.00,
                  "assets": self._acat([{"symbol": "AAA", "market_value": 1000.00}])}]
        self.assertEqual(detect_cross_account_duplicates(accts), [])

    def test_consolidate_analyses_applies_the_guard_end_to_end(self):
        consolidated = ap.consolidate_analyses(self._duplicated_extraction(), "Demo Household")
        self.assertEqual(consolidated["total_accounts"], 2)
        # All 12 positions (6 per account) forced to REVIEW; none left ACAT.
        self.assertEqual(consolidated["acat_count"], 0)
        self.assertEqual(consolidated["review_count"], 12)
        for a in consolidated["accounts"]:
            self.assertEqual(a["validation_status"], "WARNING")


class DedupNullAccountNumberTests(unittest.TestCase):
    """Regression: a T. Rowe household folder held several documents describing
    the SAME registrations (copies of the current statement + prior year-end
    statements), none with a per-account number. _dedup_accounts keyed only on
    account_number, so the copies never merged, and the cross-account guard
    force-REVIEWed every position. Keying null-account-number accounts on
    investor_number + registration collapses the copies. (Invented numbers.)
    """

    def _roth(self, date="March 31, 2026"):
        return {
            "custodian": "T. Rowe Price", "account_number": None,
            "investor_number": "DEMOINV1", "account_registration": "Roth IRA",
            "statement_date": date, "statement_portfolio_total": 140000.00,
            "total_value": 93965.00,
            "assets": [
                {"symbol": "PRGFX", "market_value": 41250.00, "transfer_eligible": "ACAT"},
                {"symbol": "PRWCX", "market_value": 36880.00, "transfer_eligible": "ACAT"},
                {"symbol": "PRNHX", "market_value": 12330.00, "transfer_eligible": "ACAT"},
                {"symbol": "PRRXX", "market_value": 3505.00, "transfer_eligible": "ACAT"},
            ],
        }

    def _rollover(self, date="March 31, 2026"):
        return {
            "custodian": "T. Rowe Price", "account_number": None,
            "investor_number": "DEMOINV1", "account_registration": "Rollover IRA",
            "statement_date": date, "statement_portfolio_total": 140000.00,
            "total_value": 46035.00,
            "assets": [
                {"symbol": "PRFDX", "market_value": 18420.00, "transfer_eligible": "ACAT"},
                {"symbol": "TRBCX", "market_value": 27615.00, "transfer_eligible": "ACAT"},
            ],
        }

    def test_multiple_copies_of_same_statement_collapse_to_one_each(self):
        # 3 copies of Roth + 3 copies of Rollover (same investor+registration).
        accts = [self._roth(), self._roth(), self._roth(),
                 self._rollover(), self._rollover(), self._rollover()]
        merged = _dedup_accounts(accts)
        self.assertEqual(len(merged), 2)
        regs = sorted(a["account_registration"] for a in merged)
        self.assertEqual(regs, ["Rollover IRA", "Roth IRA"])
        # And the guard now stays silent on the collapsed household.
        self.assertEqual(detect_cross_account_duplicates(merged), [])

    def test_different_investors_same_registration_stay_separate(self):
        # Two spouses' Roth IRAs: same label, different investor numbers.
        first = self._roth()
        second = self._roth()
        second["investor_number"] = "DEMOINV2"
        merged = _dedup_accounts([first, second])
        self.assertEqual(len(merged), 2)

    def test_null_investor_and_null_account_number_not_merged(self):
        # No identity to match on → preserve prior behavior (kept separate).
        a = {"custodian": "X", "account_number": None, "account_registration": "Roth IRA",
             "assets": [{"symbol": "AAA", "market_value": 100.0}]}
        b = {"custodian": "X", "account_number": None, "account_registration": "Roth IRA",
             "assets": [{"symbol": "BBB", "market_value": 200.0}]}
        self.assertEqual(len(_dedup_accounts([a, b])), 2)

    def test_multi_statement_household_does_not_false_positive(self):
        # One spouse's TRP statement (correct 2-account split) alongside the
        # other's own TRP statement (different investor) and a Schwab account.
        # The guard must scope per statement and stay silent.
        spouse_roth = self._roth()
        spouse_roth["investor_number"] = "DEMOINV2"
        spouse_roth["total_value"] = 52400.00
        spouse_roth["statement_portfolio_total"] = 52400.00
        spouse_roth["assets"] = [
            {"symbol": "PRDGX", "market_value": 30000.00, "transfer_eligible": "ACAT"},
            {"symbol": "PRSVX", "market_value": 22400.00, "transfer_eligible": "ACAT"},
        ]
        schwab = {"custodian": "Charles Schwab", "account_number": "****4821",
                  "total_value": 15000.00,
                  "assets": [{"symbol": "VTI", "market_value": 15000.00, "transfer_eligible": "ACAT"}]}
        accts = [self._roth(), self._rollover(), spouse_roth, schwab]
        self.assertEqual(detect_cross_account_duplicates(accts), [])
        for a in accts:
            for pos in a["assets"]:
                self.assertEqual(pos["transfer_eligible"], "ACAT")

    def test_household_with_current_and_yearend_copies_uses_current(self):
        # Current + year-end copies of each registration collapse, current wins,
        # guard clean, values are the 3/31 figures (not the higher 12/31 ones).
        roth_ye = self._roth(date="December 31, 2025")
        roth_ye["assets"][0]["market_value"] = 44100.00  # stale PRGFX
        roll_ye = self._rollover(date="December 31, 2025")
        roll_ye["assets"][1]["market_value"] = 29050.00   # stale TRBCX
        merged = _dedup_accounts([self._roth(), roth_ye, self._rollover(), roll_ye])
        self.assertEqual(len(merged), 2)
        self.assertEqual(detect_cross_account_duplicates(merged), [])
        by_reg = {a["account_registration"]: a for a in merged}
        prgfx = next(p for p in by_reg["Roth IRA"]["assets"] if p["symbol"] == "PRGFX")
        trbcx = next(p for p in by_reg["Rollover IRA"]["assets"] if p["symbol"] == "TRBCX")
        self.assertEqual(prgfx["market_value"], 41250.00)  # current, not 44100.00
        self.assertEqual(trbcx["market_value"], 27615.00)   # current, not 29050.00


class MergeRecencyTests(unittest.TestCase):
    """_merge_duplicate_accounts: a more recent snapshot wins over a stale one."""

    def _acct(self, date, assets, total, holder="Account Holder"):
        return {"custodian": "T. Rowe Price", "account_number": None,
                "investor_number": "DEMOINV1", "account_registration": "Rollover IRA",
                "account_holder": holder, "statement_date": date,
                "total_value": total, "assets": assets}

    def test_newer_statement_values_win(self):
        current = self._acct("March 31, 2026",
                             [{"symbol": "TRBCX", "market_value": 27615.00}], 46035.00)
        yearend = self._acct("December 31, 2025",
                             [{"symbol": "TRBCX", "market_value": 29050.00}], 47470.00)
        # Order-independent: newer wins regardless of which is "existing".
        for a, b in ((current, yearend), (yearend, current)):
            merged = _merge_duplicate_accounts(a, b)
            self.assertEqual(merged["assets"][0]["market_value"], 27615.00)
            self.assertEqual(merged["total_value"], 46035.00)

    def test_newer_snapshot_drops_positions_absent_from_it(self):
        # A holding sold by the current date must not be resurrected from the
        # stale statement.
        current = self._acct("March 31, 2026",
                             [{"symbol": "TRBCX", "market_value": 27615.00}], 27615.00)
        yearend = self._acct("December 31, 2025",
                             [{"symbol": "TRBCX", "market_value": 29050.00},
                              {"symbol": "SOLD", "market_value": 5000.00}], 34050.00)
        merged = _merge_duplicate_accounts(current, yearend)
        syms = {p["symbol"] for p in merged["assets"]}
        self.assertEqual(syms, {"TRBCX"})

    def test_equal_dates_still_union(self):
        # Same statement date → union behavior (larger MV on collision) preserved.
        a = self._acct("March 31, 2026",
                       [{"symbol": "TRBCX", "description": "d", "market_value": 27615.00}], 27615.00)
        b = self._acct("March 31, 2026",
                       [{"symbol": "TRBCX", "description": "d", "market_value": 27615.00},
                        {"symbol": "PRFDX", "description": "e", "market_value": 18420.00}], 46035.00)
        merged = _merge_duplicate_accounts(a, b)
        self.assertEqual({p["symbol"] for p in merged["assets"]}, {"TRBCX", "PRFDX"})

    def test_missing_dates_fall_back_to_union(self):
        a = self._acct(None, [{"symbol": "AAA", "market_value": 100.0}], 100.0)
        b = self._acct(None, [{"symbol": "BBB", "market_value": 200.0}], 200.0)
        merged = _merge_duplicate_accounts(a, b)
        self.assertEqual({p["symbol"] for p in merged["assets"]}, {"AAA", "BBB"})


if __name__ == "__main__":
    unittest.main()



class AccountTitleWordingTests(unittest.TestCase):
    """Titles that mapped to the wrong type: a TOD designation read as an inherited IRA, the spelled-out IRA read
    as an individual account, and an education account read as bank savings (S11 review)."""

    def test_titles_map_to_their_account_type(self):
        cases = {
            "Designated Bene Individual": "Individual",
            "Designated Bene Joint Tenant": "Joint",
            "Individual - Designated Beneficiary": "Individual",
            "Individual Retirement Account": "IRA",
            "Roth Individual Retirement Account": "Roth IRA",
            "Coverdell Education Savings Account": "Other",
            "Traditional IRA - Beneficiary": "Inherited IRA",
            "Bene IRA": "Inherited IRA",
            "Roth IRA (Inherited)": "Inherited Roth IRA",
            "BDA IRA": "Inherited IRA",
            "High Yield Savings": "Savings",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(normalize_account_type(raw)[0], expected)
