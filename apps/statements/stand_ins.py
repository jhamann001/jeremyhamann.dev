"""
The demo's stand-ins for the pipeline's outside services, behind the interfaces the pipeline already calls:

  * ReplayGenaiClient     takes the Gemini client's place. Each pre-screen and extraction call is answered with a
                          prepared answer for that PDF and that prompt, in the JSON the prompt asks the model for,
                          built from the statement's own data (prepared_answers). Any other PDF or prompt is
                          refused. There is no live model, and no model bill: plan decision D3, as changed
                          2026-10-29.
  * Demo*DB               the four reference lookups, in place of the firm's Notion databases: fund restrictions
                          and tickers (reference_data.py), custodians (custodian_library.py) and the receiving
                          custodian's rules (apex_rules.csv).
  * SampleStatementSource takes the Drive input folder's place: one sample household's statements (samples.py).
  * run_samples           takes the scan's place: chosen sample households through process_client_folder.

Everything after the answer runs live, through the app's own code: the answer's parsing and lot consolidation, the
pre-screen gate, cash reconciliation, the asset-type tiers, the transfer rule chain, validation, consolidation and
the write. A prepared answer reads the statement perfectly, so the guards for a model's misreadings (a value
mismatch excepted, which is planted in the statement itself) stay quiet here; their unit tests cover them.
"""

from __future__ import annotations

import csv
import functools
import hashlib
import json
import logging
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

import automation_pipeline as ap
from custodian_library import CUSTODIANS
from reference_data import FUND_RESTRICTIONS, TICKERS, TRANSFER_METHODS
from samples import AS_OF, SAMPLES, SAMPLES_BY_KEY, Document, Sample, render_document

log = logging.getLogger("statement-pipeline")
ET = ZoneInfo("America/New_York")

APP_DIR = Path(__file__).parent
APEX_RULES_CSV = APP_DIR / "apex_rules.csv"

# The two model calls the pipeline makes, by the prompt each sends.
CALLS = {"prescreen": ap._CLASSIFY_DOC_PROMPT, "extraction": ap.GEMINI_PROMPT}


def sha256(data) -> str:
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def call_for_prompt(prompt: str) -> Optional[str]:
    return next((name for name, text in CALLS.items() if text == prompt), None)


def _document_and_prompt(contents) -> tuple[bytes, str]:
    """The pipeline sends [document part, prompt text]."""
    part, prompt = contents
    return part.inline_data.data, prompt


# ---------------------------------------------------------------------------
# Dates: the replay keeps each statement as old as it was on the universe's as-of date
# ---------------------------------------------------------------------------

def replay_shift_days(today: Optional[date] = None) -> int:
    """Whole weeks from the universe's as-of date to today, so weekdays stay weekdays."""
    days = ((today or datetime.now(ET).date()) - AS_OF).days
    return max(0, days - days % 7)


_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
           "November", "December")
_DATE_PATTERN = re.compile(
    r"(?P<iso>\b\d{4}-\d{2}-\d{2}\b)"
    r"|(?P<us>\b\d{1,2}/\d{1,2}/\d{4}\b)"
    r"|(?P<long>\b(?:" + "|".join(m[:3] for m in _MONTHS) + r")[a-z]*\.? \d{1,2}, \d{4}\b)"
)


def shift_dates_in(text: str, days: int) -> str:
    """Every full date in *text* (2026-09-30, 09/30/2026, September 30, 2026) moved forward *days*, in its own
    format. Anything that isn't a full date is left alone."""
    def move(m: re.Match) -> str:
        raw = m.group(0)
        if m.group("iso"):
            return (datetime.strptime(raw, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")
        if m.group("us"):
            return (datetime.strptime(raw, "%m/%d/%Y") + timedelta(days=days)).strftime("%m/%d/%Y")
        month, rest = raw.split(" ", 1)
        full = next(name for name in _MONTHS if name.startswith(month.rstrip(".")[:3]))
        moved = datetime.strptime(f"{full} {rest}", "%B %d, %Y") + timedelta(days=days)
        name = _MONTHS[moved.month - 1]
        return f"{name if len(month.rstrip('.')) > 3 else name[:3]} {moved.day}, {moved.year}"
    return _DATE_PATTERN.sub(move, text) if days else text


def shift_answer_dates(text: str, days: int) -> str:
    """An answer with its statement dates and lot acquisition dates moved forward. Only those fields move;
    descriptions (a bond's maturity) stay as printed. An answer that isn't JSON is returned unchanged, for the
    pipeline's own repair step."""
    if not days:
        return text
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else ""
    if raw.endswith("```"):
        raw = raw.rsplit("```", 1)[0]
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return text
    for account in parsed if isinstance(parsed, list) else [parsed]:
        if not isinstance(account, dict):
            continue
        if isinstance(account.get("statement_date"), str):
            account["statement_date"] = shift_dates_in(account["statement_date"], days)
        for position in account.get("positions") or account.get("assets") or []:
            for lot in (position.get("lots") or []) if isinstance(position, dict) else []:
                if isinstance(lot, dict) and isinstance(lot.get("acquisition_date"), str):
                    lot["acquisition_date"] = shift_dates_in(lot["acquisition_date"], days)
    return json.dumps(parsed)


# ---------------------------------------------------------------------------
# The model: prepared answers, replayed
# ---------------------------------------------------------------------------

_PRESCREEN_TYPES = {"bank": "bank_statement", "proposal": "performance_report"}


def _number(printed: str) -> float:
    """A printed quantity ("2,104.330", "2 contracts") as the number the prompt asks for."""
    return float(printed.split()[0].replace(",", ""))


def prescreen_answer(doc: Document) -> dict:
    """The pre-screen's answer for a statement, in the JSON _CLASSIFY_DOC_PROMPT asks for."""
    return {
        "doc_type": _PRESCREEN_TYPES.get(doc.kind, "investment_statement"),
        "statement_date": doc.period_end.strftime("%m/%d/%Y"),
        "confidence": "high",
    }


def extraction_answer(doc: Document) -> list[dict]:
    """The extraction's answer for a statement, in the per-account JSON GEMINI_PROMPT asks for: every account,
    position and lot as printed, the printed totals (so a planted mismatch stays a mismatch), and the shared
    investor number and registration labels where the statement has them."""
    portfolio_total = round(sum(a.total for a in doc.accounts), 2)
    return [{
        "custodian": doc.issuer,
        "account_number": a.number,
        "investor_number": doc.investor_number,
        "account_registration": a.title if doc.investor_number else None,
        "account_type_raw": a.title,
        "account_holder": a.holders,
        "statement_date": doc.period_end.strftime("%m/%d/%Y"),
        "statement_portfolio_total": portfolio_total,
        "positions": [{
            "symbol": h.symbol,
            "description": h.description,
            "quantity": _number(h.quantity),
            "market_value": h.value,
            "cost_basis": h.cost_basis,
            "lots": [{"acquisition_date": lot.acquired, "quantity": _number(lot.quantity),
                      "cost_basis": lot.cost_basis, "market_value": lot.value} for lot in h.lots],
        } for h in a.holdings],
        "cash_balance": a.cash or None,
        "total_value": a.total,
    } for a in doc.accounts]


def passes_prescreen(doc: Document) -> bool:
    return ap.evaluate_doc_gate(prescreen_answer(doc)["doc_type"], bypass=False)[0] == "process"


def answers_for(samples: Iterable[Sample]) -> dict[tuple[str, str], str]:
    """Every answer the pipeline asks for across these samples' statements, keyed by (SHA-256 of the PDF, SHA-256
    of the prompt): a pre-screen for each statement, and an extraction for each one the pre-screen lets through."""
    answers = {}
    for sample in samples:
        for doc in sample.documents:
            pdf = sha256(render_document(doc))
            prescreen = prescreen_answer(doc)
            answers[(pdf, sha256(CALLS["prescreen"]))] = json.dumps(prescreen)
            if passes_prescreen(doc):
                answers[(pdf, sha256(CALLS["extraction"]))] = json.dumps(extraction_answer(doc))
    return answers


@functools.lru_cache(maxsize=1)
def prepared_answers() -> dict[tuple[str, str], str]:
    """The answers for the sample statements a visitor can run."""
    return answers_for(SAMPLES)


class ReplayMissing(RuntimeError):
    """No prepared answer for this PDF and prompt. The message has no digits: the pipeline retries errors whose
    text contains a status code, and a hash could look like one."""


class _ReplayModels:
    def __init__(self, client: "ReplayGenaiClient"):
        self._client = client

    def generate_content(self, model, contents, config=None):
        return SimpleNamespace(text=self._client.answer(contents))

    def generate_content_stream(self, model, contents, config=None):
        return iter([SimpleNamespace(text=self._client.answer(contents))])


class ReplayGenaiClient:
    """The Gemini client's interface (models.generate_content and generate_content_stream), answered from a table
    of answers keyed by the SHA-256 of the PDF and of the prompt."""

    def __init__(self, answers: dict[tuple[str, str], str], shift_days: int = 0):
        self._answers = answers
        self.shift_days = shift_days
        self.models = _ReplayModels(self)

    @classmethod
    def prepared(cls, today: Optional[date] = None) -> "ReplayGenaiClient":
        return cls(prepared_answers(), replay_shift_days(today))

    def answer(self, contents) -> str:
        document, prompt = _document_and_prompt(contents)
        text = self._answers.get((sha256(document), sha256(prompt)))
        if text is None:
            call = call_for_prompt(prompt) or "unknown"
            raise ReplayMissing(f"No prepared answer for this document ({call} call); "
                                "the demo never calls a live model")
        return shift_answer_dates(text, self.shift_days)


# ---------------------------------------------------------------------------
# Reference lookups, in place of the Notion databases
# ---------------------------------------------------------------------------

class DemoRestrictionDB(ap.NotionRestrictionDB):
    """The mutual fund restriction list (reference_data.FUND_RESTRICTIONS). check_symbol is the pipeline's own."""

    def __init__(self):
        self.restrictions: dict[str, dict] = {}

    def query_symbols(self, symbols: list[str], timeout: Optional[float] = None):
        for raw in symbols:
            symbol = (raw or "").upper().strip()
            if symbol in FUND_RESTRICTIONS:
                self.restrictions[symbol] = {"symbol": symbol, "omni_l_3": FUND_RESTRICTIONS[symbol],
                                             "page_id": None}

    def query_cusips(self, cusips: list[str]) -> dict[str, str]:
        return {}


class DemoTickerDB(ap.NotionTickerDB):
    """The security classification table (reference_data.TICKERS). lookup is the pipeline's own."""

    def __init__(self):
        self.tickers: dict[str, dict] = {}

    def query_symbols(self, symbols: list[str]):
        for raw in symbols:
            symbol = (raw or "").upper().strip()
            if symbol in TICKERS:
                self.tickers[symbol] = dict(TICKERS[symbol])


def _custodian_contact(c: dict) -> str:
    parts = [
        ("Signature", c.get("signature")),
        ("Medallion", c.get("medallion_required")),
        ("Letter of acceptance", c.get("letter_of_acceptance")),
        ("Paperwork returned by", c.get("return_method")),
    ]
    return ". ".join(f"{label}: {value}" for label, value in parts if value)


class DemoCustodianDB(ap.NotionCustodianDB):
    """The Transfer Tracker demo's custodian library (custodian_library.py). lookup is the pipeline's own."""

    def __init__(self):
        self.custodians: dict[str, dict] = {}
        self._alias_map: dict[str, str] = {}
        for c in CUSTODIANS:
            norm = self._normalize(c["name"])
            self.custodians[norm] = {
                "name": c["name"],
                "dtcc_number": c.get("dtc") or "",
                "acat_timeline": TRANSFER_METHODS.get(c.get("transfer_type") or "", ""),
                "contact_info": _custodian_contact(c),
                "details": c.get("watchouts") or "",
            }
            self._alias_map[norm] = norm


class DemoApexRulesDB(ap.NotionApexRulesDB):
    """The receiving custodian's account and asset rules, read from apex_rules.csv, the file the firm's Notion
    database was imported from. The lookups are the pipeline's own."""

    def __init__(self, path: Path = APEX_RULES_CSV):
        self.rules: list[dict] = []
        with open(path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                account_type = (row.get("Account Type") or "").strip()
                if not account_type:
                    continue
                rule_type = (row.get("Rule Type") or "").strip().upper()
                if rule_type not in ("UNSUPPORTED", "SPECIAL HANDLING"):
                    rule_type = "SPECIAL HANDLING"
                keywords = [k.strip().lower() for k in (row.get("Match Keywords") or "").split(",") if k.strip()]
                self.rules.append({
                    "account_type": account_type,
                    "rule_type": rule_type,
                    "keywords": keywords or [account_type.lower()],
                    "notes": (row.get("Special Handling") or "").strip(),
                    "scope": ap._infer_apex_rule_scope(account_type),
                })


@functools.lru_cache(maxsize=1)
def demo_apex_rules() -> DemoApexRulesDB:
    return DemoApexRulesDB()


# ---------------------------------------------------------------------------
# Intake: sample statements in place of the Drive input folder
# ---------------------------------------------------------------------------

class SampleStatementSource:
    """One sample household's statements, rendered on demand: the same four methods as ap.DriveSource."""

    throttle_seconds = 0

    def __init__(self, sample: Sample):
        self.sample = sample
        self._documents = {d.filename: d for d in sample.documents}

    def prepare(self, folder: dict) -> None:
        pass

    def list_documents(self, folder: dict) -> list[dict]:
        return [{"id": d.filename, "name": d.filename, "mimeType": "application/pdf"} for d in self.sample.documents]

    def download(self, doc_meta: dict, dest_path: str) -> None:
        Path(dest_path).write_bytes(render_document(self._documents[doc_meta["id"]]))

    def archive(self, doc_meta: dict) -> None:
        pass


def sample_folder_id(key: str) -> str:
    """The household's source folder id: every run of the same sample is a new run of the same client."""
    return f"sample-{key}"


def run_samples(keys: Iterable[str], db_conn, *, replay: Optional[ReplayGenaiClient] = None) -> list[dict]:
    """
    Run sample households through process_client_folder as a scan runs Drive folders, then post the scan summary
    (the Outbox, in demo mode). The caller holds the scan lock: the model client is module state.
    """
    replay = replay or ReplayGenaiClient.prepared()
    restrictions, tickers = DemoRestrictionDB(), DemoTickerDB()
    custodians, apex_rules = DemoCustodianDB(), demo_apex_rules()
    results: list[dict] = []
    previous = ap._genai_client
    ap._genai_client = replay
    try:
        for key in keys:
            sample = SAMPLES_BY_KEY[key]
            folder = {"id": sample_folder_id(key), "name": sample.client_name}
            try:
                household_id = ap.process_client_folder(
                    drive=None, folder=folder, notion_db=restrictions, custodian_db=custodians,
                    apex_rules_db=apex_rules, ticker_db=tickers, db_conn=db_conn, processed_folder_id=None,
                    source=SampleStatementSource(sample),
                )
            except Exception as exc:
                log.exception("Sample %s failed: %s", key, exc)
                db_conn.rollback()
                # Only the replay's own refusal is shown; anything else may carry internal detail.
                error = str(exc) if isinstance(exc, ReplayMissing) else "Processing failed; see the server log"
                results.append({"client": sample.client_name, "sample": key, "status": "error", "error": error})
                continue
            if household_id:
                results.append({"client": sample.client_name, "sample": key, "status": "success",
                                "household_id": household_id})
            else:
                results.append({"client": sample.client_name, "sample": key, "status": "skipped",
                                "reason": "No extractable documents found"})
    finally:
        ap._genai_client = previous
    if results:
        ap.send_slack_notification(results)
    return results
