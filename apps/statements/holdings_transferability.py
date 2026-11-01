"""Read-only Plaid holdings transferability preview.

Runs the in-memory transfer classifier. This module does not write
households, upload to Drive, post to Slack, or link clients. It does not
invent an account subtype: rollover, inherited, and bank-rail short-circuits
stay off unless a tested Plaid subtype is supplied, and this preview does
not supply one.

Asset type comes from the caller's security_type. The five-letter ticker
heuristic is not used.
"""

from __future__ import annotations

import concurrent.futures
import os
from typing import Any, Callable, Optional

from automation_pipeline import classify_transfer_eligibility

LABEL_TRANSFERABLE = "likely_transferable"
LABEL_NOT = "likely_not"
LABEL_UNKNOWN = "unknown"

RULES_OK = "ok"
RULES_UNAVAILABLE = "unavailable"

# Plaid security_type values. Anything else stays unknown.
_SECURITY_TYPE_MAP = {
    "mutual fund": "Mutual Fund",
    "mutual_fund": "Mutual Fund",
    "etf": "ETF",
    "equity": "Equity",
    "fixed income": "Fixed Income",
    "fixed_income": "Fixed Income",
    "cash": "Cash",
}

# Reasons are stable codes. They never include a ticker, CUSIP, or ISIN.
REASON_OMNI = "omni"
REASON_NON_OMNI = "mutual_fund_non_omni"
REASON_UNLISTED = "mutual_fund_unlisted"
REASON_MISSING_SYMBOL = "missing_symbol"
REASON_MISSING_TYPE = "missing_security_type"
REASON_UNRECOGNIZED_TYPE = "unrecognized_security_type"
REASON_RULES_UNAVAILABLE = "rules_unavailable"
REASON_FIXED_INCOME = "fixed_income"
REASON_APEX_UNSUPPORTED = "apex_asset_unsupported"
REASON_STANDARD = "standard_security"
REASON_CASH = "cash"
REASON_NEEDS_REVIEW = "needs_review"


class RulesUnavailable(Exception):
    """The restriction lookup timed out or failed. Every row stays unknown."""


def classify_plaid_holdings_preview(
    rows: list[dict],
    *,
    query_symbols: Optional[Callable[[list[str]], None]] = None,
    check_symbol: Optional[Callable[[str], dict]] = None,
    apex_asset_rule: Optional[Callable[[str], Optional[dict]]] = None,
    timeout_seconds: float = 4.0,
) -> dict:
    """Classify one preview batch.

    ``query_symbols`` / ``check_symbol`` are the Notion mutual-fund
    restriction lookup. A timeout or any exception from that lookup, or
    from a supplied Apex asset-rule callback, returns rules_unavailable
    for every row. Account subtype is ignored.
    """
    prepared = [_prepare(row) for row in rows]
    try:
        _load_mutual_fund_rules(prepared, query_symbols, timeout_seconds)
        classified = [
            _classify_one(
                row,
                check_symbol=check_symbol,
                apex_asset_rule=apex_asset_rule,
            )
            for row in prepared
        ]
    except RulesUnavailable:
        return _unavailable(len(rows))
    return {"rules_status": RULES_OK, "rows": classified}


def _prepare(row: dict) -> dict:
    raw_symbol = row.get("symbol")
    symbol = raw_symbol.strip().upper() if isinstance(raw_symbol, str) else ""
    raw_type = row.get("security_type")
    security_type = " ".join(raw_type.split()).lower() if isinstance(raw_type, str) else ""
    return {
        "symbol": symbol or None,
        "security_type": security_type,
        "asset_type": _SECURITY_TYPE_MAP.get(security_type),
    }


def _load_mutual_fund_rules(
    prepared: list[dict],
    query_symbols: Optional[Callable[[list[str]], None]],
    timeout_seconds: float,
) -> None:
    symbols = [
        row["symbol"]
        for row in prepared
        if row["asset_type"] == "Mutual Fund" and row["symbol"]
    ]
    if not symbols:
        return
    if query_symbols is None:
        raise RulesUnavailable("restriction lookup is not configured")
    _run_bounded(lambda: query_symbols(symbols), timeout_seconds)


def _run_bounded(fn: Callable[[], None], timeout_seconds: float) -> None:
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(fn)
        try:
            future.result(timeout=timeout_seconds)
        except concurrent.futures.TimeoutError as exc:
            raise RulesUnavailable("timeout") from exc
        except RulesUnavailable:
            raise
        except Exception as exc:
            raise RulesUnavailable("exception") from exc
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _classify_one(
    row: dict,
    *,
    check_symbol: Optional[Callable[[str], dict]],
    apex_asset_rule: Optional[Callable[[str], Optional[dict]]],
) -> dict:
    asset_type = row["asset_type"]
    symbol = row["symbol"]
    if asset_type is None:
        reason = REASON_MISSING_TYPE if not row["security_type"] else REASON_UNRECOGNIZED_TYPE
        return _unknown(reason)
    # A name without a ticker cannot be looked up. Fixed income is the
    # exception: the liquidate rule is on the security type itself.
    if not symbol and asset_type != "Fixed Income":
        return _unknown(REASON_MISSING_SYMBOL)

    notion_check = None
    if asset_type == "Mutual Fund":
        if check_symbol is None:
            raise RulesUnavailable("restriction lookup is not configured")
        try:
            notion_check = check_symbol(symbol)
        except Exception as exc:
            raise RulesUnavailable("exception") from exc

    rule = None if asset_type == "Mutual Fund" else _asset_rule(asset_type, apex_asset_rule)
    status, _notes = classify_transfer_eligibility(
        asset={"symbol": symbol or "", "type": asset_type, "classification_source": "security_type"},
        account_type="",
        is_rollover=False,
        notion_check=notion_check,
        apex_acct_rule=None,
        apex_asset_rule=rule,
    )
    if asset_type == "Mutual Fund":
        # Notes from the engine include the ticker. Map from the lookup
        # instead, which is the same Omni / non-Omni / unlisted decision.
        return _mutual_fund_label(notion_check)
    return _engine_label(status, asset_type, rule)


def _asset_rule(
    asset_type: str,
    apex_asset_rule: Optional[Callable[[str], Optional[dict]]],
) -> Optional[dict]:
    # The live Apex Mutual Fund Companies rule must not preempt Omni.
    # Mutual funds are labeled from the restriction list before this runs.
    if apex_asset_rule is None or asset_type == "Mutual Fund":
        return None
    try:
        rule = apex_asset_rule(asset_type)
    except Exception as exc:
        raise RulesUnavailable("exception") from exc
    if not rule:
        return None
    label = str(rule.get("account_type") or "")
    if "Mutual Fund Companies" in label:
        return None
    return rule


def _mutual_fund_label(notion_check: Optional[dict]) -> dict:
    if not notion_check or not notion_check.get("in_notion"):
        return _unknown(REASON_UNLISTED)
    if notion_check.get("transferrable"):
        return {"label": LABEL_TRANSFERABLE, "reason": REASON_OMNI}
    # Non-Omni matches the engine's REVIEW status: unknown, not likely_not.
    return _unknown(REASON_NON_OMNI)


def _engine_label(status: str, asset_type: str, rule: Optional[dict]) -> dict:
    if status in ("LIQUIDATE", "UNSUPPORTED") and rule and rule.get("rule_type") == "UNSUPPORTED":
        return {"label": LABEL_NOT, "reason": REASON_APEX_UNSUPPORTED}
    if status == "LIQUIDATE" and asset_type == "Fixed Income":
        return {"label": LABEL_NOT, "reason": REASON_FIXED_INCOME}
    if status == "ACH/WIRE":
        return {"label": LABEL_NOT, "reason": "bank_rail"}
    if status == "LIQUIDATE":
        # Rollover liquidation is only reached when is_rollover is set.
        # This preview never sets it, so a stray liquidate stays unknown.
        return _unknown(REASON_NEEDS_REVIEW)
    if status == "ACAT" and asset_type in ("Equity", "ETF"):
        return {"label": LABEL_TRANSFERABLE, "reason": REASON_STANDARD}
    if status == "ACAT" and asset_type == "Cash":
        return {"label": LABEL_TRANSFERABLE, "reason": REASON_CASH}
    return _unknown(REASON_NEEDS_REVIEW)


def _unknown(reason: str) -> dict:
    return {"label": LABEL_UNKNOWN, "reason": reason}


def _unavailable(count: int) -> dict:
    return {
        "rules_status": RULES_UNAVAILABLE,
        "rows": [_unknown(REASON_RULES_UNAVAILABLE) for _ in range(count)],
    }


def preview_restriction_callables(
    timeout_seconds: float,
) -> tuple[Optional[Callable[[list[str]], None]], Optional[Callable[[str], dict]]]:
    """Notion mutual-fund restriction lookup, or (None, None) when unset.

    Constructing the client does not query Notion. The query itself is
    bounded by ``timeout_seconds`` and uses no retry adapter.
    """
    api_key = (os.getenv("NOTION_TOKEN_KEY") or "").strip()
    database_id = (os.getenv("NOTION_DATABASE_ID") or "").strip()
    if not api_key or not database_id:
        return None, None
    from automation_pipeline import NotionRestrictionDB

    db = NotionRestrictionDB(api_key, database_id)

    def query(symbols: list[str]) -> None:
        db.query_symbols(symbols, timeout=timeout_seconds)

    return query, db.check_symbol


def response_leaks_identifier(payload: Any, symbols: list[str]) -> bool:
    """True when a preview payload echoes a ticker or a forbidden identifier."""
    blob = str(payload).upper()
    if any(token in blob for token in ("CUSIP", "ISIN", "ACCESS_TOKEN", "COST_BASIS")):
        return True
    for symbol in symbols:
        if symbol and symbol.upper() in blob:
            return True
    return False
