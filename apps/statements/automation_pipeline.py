"""
ACAT Statement Automation Pipeline
===================================
Watches a Google Drive folder for new client statements (PDF, PNG, JPEG),
analyzes them with Vertex AI (Gemini 3.5 Flash), cross-references a Notion
restriction database, and generates a formatted Google Sheet report.

Author: Built for Cedar Ridge Wealth
"""

import os
import re
import json
import time
import logging
import tempfile
from datetime import datetime
from io import BytesIO
from typing import Optional
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload
from google import genai
from google.genai import types

import psycopg2
import db as pipeline_db
import demo

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("statement-pipeline")

# ---------------------------------------------------------------------------
# Google Gen AI client (initialized in run_once / run_pipeline)
# ---------------------------------------------------------------------------
_genai_client: genai.Client | None = None


def _init_genai(project: str, location: str, model: str = "") -> genai.Client:
    """Create (or re-create) the module-level Gen AI client for Vertex AI.

    Gemini 3.x models (including previews and the flash tier) are only served
    on the global endpoint, so we override *location* automatically for them.
    """
    global _genai_client
    if "preview" in model or model.startswith("gemini-3"):
        location = "global"
    _genai_client = genai.Client(vertexai=True, project=project, location=location)
    return _genai_client


# ---------------------------------------------------------------------------
# HTTP session with retry (for Notion calls)
# ---------------------------------------------------------------------------
def _build_retry_session(
    retries: int = 3,
    backoff_factor: float = 1.0,
    status_forcelist: tuple = (429, 500, 502, 503, 504),
) -> requests.Session:
    """Return a requests Session with automatic retry on transient errors."""
    session = requests.Session()
    retry = Retry(
        total=retries,
        backoff_factor=backoff_factor,
        status_forcelist=status_forcelist,
        allowed_methods=["POST", "GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


# ---------------------------------------------------------------------------
# Warehouse client — fetch a client's open Apex accounts (best-effort enrichment)
# ---------------------------------------------------------------------------
class WarehouseClient:
    """Thin client over the Warehouse API. Used to enrich destination suggestions
    with the actual Apex account number for an existing open account, looked up
    by owner name. Best-effort + display-only: any failure returns []."""

    def __init__(self, base_url: str, api_key: str, database_id: int):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = (api_key or "").strip()
        self.database_id = int(database_id)
        self._session = _build_retry_session()

    @classmethod
    def from_env(cls) -> "Optional[WarehouseClient]":
        url, key = os.getenv("WAREHOUSE_URL"), os.getenv("WAREHOUSE_API_KEY")
        database = os.getenv("WAREHOUSE_DATABASE_ID")
        if not url or not key or not database:
            return None
        return cls(url, key, int(database))

    def _headers(self) -> dict:
        return {"x-api-key": self.api_key, "Content-Type": "application/json"}

    def open_accounts_by_name(self, first_name: str, last_name: str) -> list:
        """Return [{account_type, custodian_account_number}] of OPEN accounts for
        a person, matched by first+last name. Empty list on any error."""
        if not (first_name and last_name):
            return []
        sql = (
            "SELECT a.account_type, a.custodian_account_number "
            "FROM warehouse.open_accounts a "
            "WHERE LOWER(a.owner_first_name) = LOWER({{first}}) AND LOWER(a.owner_last_name) = LOWER({{last}})"
        )
        payload = {
            "database": self.database_id,
            "type": "native",
            "native": {
                "query": sql,
                "template-tags": {
                    "first": {"id": "first", "name": "first", "display-name": "first", "type": "text"},
                    "last": {"id": "last", "name": "last", "display-name": "last", "type": "text"},
                },
            },
            "parameters": [
                {"type": "category", "target": ["variable", ["template-tag", "first"]], "value": first_name},
                {"type": "category", "target": ["variable", ["template-tag", "last"]], "value": last_name},
            ],
        }
        try:
            resp = self._session.post(
                f"{self.base_url}/api/dataset", headers=self._headers(), json=payload, timeout=20,
            )
            resp.raise_for_status()
            data = resp.json().get("data", {})
            cols = [c.get("name") for c in data.get("cols", [])]
            return [dict(zip(cols, row)) for row in data.get("rows", [])]
        except Exception as exc:
            log.warning("  Warehouse lookup failed for %s %s: %s", first_name, last_name, exc)
            return []

    def custodian_number_map(self) -> dict:
        """Return {custodian_account_id: friendly_custodian_account_number} for
        accounts that have one. The roster's trading_account_no == custodian_account_id,
        so this maps the Meridian id to the Apex number (e.g. DEMO-482113). {} on error."""
        sql = ("SELECT custodian_account_id, custodian_account_number FROM warehouse.open_accounts "
               "WHERE custodian_account_id IS NOT NULL AND custodian_account_number IS NOT NULL")
        payload = {"database": self.database_id, "type": "native", "native": {"query": sql}}
        try:
            resp = self._session.post(
                f"{self.base_url}/api/dataset", headers=self._headers(), json=payload, timeout=30,
            )
            resp.raise_for_status()
            data = resp.json().get("data", {})
            cols = [c.get("name") for c in data.get("cols", [])]
            out = {}
            for row in data.get("rows", []):
                d = dict(zip(cols, row))
                if d.get("custodian_account_id"):
                    out[d["custodian_account_id"]] = d.get("custodian_account_number")
            return out
        except Exception as exc:
            log.warning("  Warehouse custodian map failed: %s", exc)
            return {}


def backfill_all_destinations(db_conn) -> dict:
    """Seed destinations for every active (non-superseded) household that doesn't
    have them yet — one-time backfill for households processed before this feature.
    Idempotent: skips already-linked source accounts, never overwrites Ops edits.
    Run AFTER the roster is loaded so needs_to_be_opened reflects existing accounts."""
    import psycopg2.extras
    warehouse = WarehouseClient.from_env()  # build once, reuse across households
    with db_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT id, source_folder_id FROM households WHERE superseded_by IS NULL")
        households = [dict(r) for r in cur.fetchall()]
    total_seeded = 0
    households_touched = 0
    for hh in households:
        if not hh.get("source_folder_id"):
            continue
        with db_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT custodian, account_number, account_holder, account_type
                   FROM accounts WHERE household_id = %s AND deleted_at IS NULL""",
                (hh["id"],),
            )
            accts = [dict(r) for r in cur.fetchall()]
        seeded = _seed_destination_accounts(db_conn, hh["source_folder_id"], accts, warehouse=warehouse)
        total_seeded += seeded
        if seeded:
            households_touched += 1
    log.info("Backfill: %d households, %d newly seeded, %d destinations created",
             len(households), households_touched, total_seeded)
    return {"households": len(households), "households_seeded": households_touched,
            "destinations_seeded": total_seeded}


def backfill_statement_freshness(db_conn) -> dict:
    """One-time: recompute and persist statement_age_days / is_stale for every
    account from its statement_date, using the current parser + threshold. The
    app computes freshness live on read, so this only refreshes the stored
    columns (e.g. for direct DB / Warehouse queries), including households
    processed before the staleness flag existed."""
    import psycopg2.extras
    threshold = statement_stale_days()
    with db_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT id, statement_date FROM accounts WHERE deleted_at IS NULL")
        rows = [dict(r) for r in cur.fetchall()]
    updated, stale = 0, 0
    with db_conn.cursor() as cur:
        for r in rows:
            age = _statement_age_days(r.get("statement_date"))
            is_stale = bool(age is not None and age > threshold)
            if is_stale:
                stale += 1
            cur.execute(
                "UPDATE accounts SET statement_age_days = %s, is_stale = %s WHERE id = %s",
                (age, is_stale, r["id"]),
            )
            updated += cur.rowcount
    db_conn.commit()
    log.info("Staleness backfill: %d accounts updated, %d now flagged stale (threshold %dd)",
             updated, stale, threshold)
    return {"accounts": len(rows), "updated": updated, "stale": stale, "threshold_days": threshold}


# ---------------------------------------------------------------------------
# Google Drive helpers
# ---------------------------------------------------------------------------
SCOPES = [
    "https://www.googleapis.com/auth/drive",
]

SUPPORTED_MIME_TYPES = {
    "application/pdf": ".pdf",
    "image/png":       ".png",
    "image/jpeg":      ".jpg",
}


def build_google_services(credentials_path: str):
    """Authenticate and return the Drive service object."""
    creds = Credentials.from_service_account_file(credentials_path, scopes=SCOPES)
    drive = build("drive", "v3", credentials=creds)
    return drive


def list_subfolders(drive, parent_id: str) -> list[dict]:
    """Return immediate child folders inside *parent_id*."""
    q = (
        f"'{parent_id}' in parents "
        "and mimeType = 'application/vnd.google-apps.folder' "
        "and trashed = false"
    )
    resp = drive.files().list(
        q=q, fields="files(id, name)",
        includeItemsFromAllDrives=True, supportsAllDrives=True,
    ).execute()
    return resp.get("files", [])


def list_documents_in_folder(drive, folder_id: str) -> list[dict]:
    """Return supported document files (PDF, PNG, JPEG) inside a folder.

    Issues one Drive query per MIME type to avoid compound-OR parsing issues
    in the Drive API query language.
    """
    all_files: list[dict] = []
    for mime in SUPPORTED_MIME_TYPES:
        q = (
            f"'{folder_id}' in parents "
            f"and mimeType = '{mime}' "
            "and trashed = false"
        )
        resp = drive.files().list(
            q=q, fields="files(id, name, mimeType)",
            includeItemsFromAllDrives=True, supportsAllDrives=True,
        ).execute()
        all_files.extend(resp.get("files", []))
    return all_files


def download_file(drive, file_id: str, dest_path: str) -> str:
    """Download a Drive file to a local path. Returns the path."""
    request = drive.files().get_media(fileId=file_id, supportsAllDrives=True)
    with open(dest_path, "wb") as fh:
        downloader = MediaIoBaseDownload(fh, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
    return dest_path


def upload_pdf_to_folder(
    drive,
    pdf_bytes: bytes,
    filename: str,
    folder_id: str,
) -> dict:
    """Upload a PDF into *folder_id*. Returns {id, webViewLink}."""
    media = MediaIoBaseUpload(
        BytesIO(pdf_bytes),
        mimetype="application/pdf",
        resumable=False,
    )
    meta = {"name": filename, "parents": [folder_id]}
    return drive.files().create(
        body=meta,
        media_body=media,
        fields="id, webViewLink",
        supportsAllDrives=True,
    ).execute()


def move_file_to_folder(drive, file_id: str, target_folder_id: str):
    """Move a file into *target_folder_id* (removes from current parent)."""
    file_meta = drive.files().get(
        fileId=file_id, fields="parents", supportsAllDrives=True,
    ).execute()
    prev_parents = ",".join(file_meta.get("parents", []))
    drive.files().update(
        fileId=file_id,
        addParents=target_folder_id,
        removeParents=prev_parents,
        fields="id, parents",
        supportsAllDrives=True,
    ).execute()


def get_or_create_subfolder(drive, parent_id: str, name: str) -> str:
    """Return the ID of a child folder named *name* under *parent_id*, creating it if needed."""
    # Drive query strings escape both backslash and quote; a backslash left as-is would escape the quote after it.
    safe_name = name.replace("\\", "\\\\").replace("'", "\\'")
    q = (
        f"'{parent_id}' in parents "
        f"and name = '{safe_name}' "
        "and mimeType = 'application/vnd.google-apps.folder' "
        "and trashed = false"
    )
    resp = drive.files().list(
        q=q, fields="files(id)",
        includeItemsFromAllDrives=True, supportsAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    if files:
        return files[0]["id"]
    meta = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    created = drive.files().create(
        body=meta, fields="id",
        supportsAllDrives=True,
    ).execute()
    return created["id"]


# ---------------------------------------------------------------------------
# Notion reference database – restriction database
# ---------------------------------------------------------------------------
class NotionRestrictionDB:
    """
    Mutual Fund Restriction Database (backed by Notion).

    Queries Notion on-demand for only the mutual fund symbols extracted
    from each statement, using a compound OR filter to fetch all needed
    symbols in a single API call. This avoids downloading the entire
    database on startup.
    """

    def __init__(self, api_key: str, database_id: str):
        self.api_key = api_key.strip()
        self.database_id = database_id.strip()
        self.restrictions: dict[str, dict] = {}  # symbol -> row data
        self._session = _build_retry_session()
        self._symbol_property: Optional[str] = None
        self._symbol_prop_type: Optional[str] = None

    # -- internal -----------------------------------------------------------
    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        }

    def _discover_symbol_property(self, timeout: Optional[float] = None):
        """Fetch the database schema to find the property that holds ticker symbols."""
        url = f"https://api.notion.com/v1/databases/{self.database_id}"
        # A bounded preview call uses a one-shot session so the pipeline's
        # retry adapter cannot keep querying Notion after the caller gave up.
        session = self._session if timeout is None else requests.Session()
        resp = session.get(url, headers=self._headers(), timeout=timeout)
        resp.raise_for_status()
        props = resp.json().get("properties", {})

        # Prefer a dedicated "symbol" property if it exists
        for name, prop in props.items():
            if name.lower() == "symbol":
                self._symbol_property = name
                self._symbol_prop_type = prop["type"]
                return

        # Fall back to title property
        for name, prop in props.items():
            if prop.get("type") == "title":
                self._symbol_property = name
                self._symbol_prop_type = "title"
                return

        raise ValueError("No symbol or title property found in Notion restriction database")

    def query_symbols(self, symbols: list[str], timeout: Optional[float] = None):
        """
        Query Notion for a specific batch of ticker symbols using a
        compound OR filter. Results are cached in self.restrictions
        for subsequent check_symbol() calls.

        Notion compound filters support up to 100 conditions, so
        larger batches are automatically chunked.

        ``timeout`` bounds each HTTP call. When it is set, this method
        uses a session without the pipeline retry adapter.
        """
        unique_symbols = list({s.upper().strip() for s in symbols if s})
        if not unique_symbols:
            return

        if self._symbol_property is None:
            self._discover_symbol_property(timeout=timeout)

        session = self._session if timeout is None else requests.Session()

        url = f"https://api.notion.com/v1/databases/{self.database_id}/query"
        found = 0

        for i in range(0, len(unique_symbols), 100):
            batch = unique_symbols[i : i + 100]
            filter_body = {
                "or": [
                    {
                        "property": self._symbol_property,
                        self._symbol_prop_type: {"equals": sym},
                    }
                    for sym in batch
                ]
            }

            has_more = True
            start_cursor: Optional[str] = None

            while has_more:
                payload: dict = {"filter": filter_body, "page_size": 100}
                if start_cursor:
                    payload["start_cursor"] = start_cursor

                resp = session.post(
                    url, headers=self._headers(), json=payload, timeout=timeout
                )
                resp.raise_for_status()
                data = resp.json()

                for page in data.get("results", []):
                    props = page.get("properties", {})
                    symbol = self._extract_symbol(props)
                    if not symbol:
                        continue
                    omni = self._extract_omni(props)
                    self.restrictions[symbol.upper()] = {
                        "symbol": symbol.upper(),
                        "omni_l_3": omni,
                        "page_id": page["id"],
                    }
                    found += 1

                has_more = data.get("has_more", False)
                start_cursor = data.get("next_cursor")

        log.info(
            "Notion queried: %d of %d symbol(s) found",
            found,
            len(unique_symbols),
        )

    def query_cusips(self, cusips: list[str]) -> dict[str, str]:
        """
        Query Notion by the ``cusip`` column for a batch of CUSIP identifiers.

        For each match the restriction data is cached (keyed by CUSIP) so that
        ``check_symbol(cusip)`` works later.  Returns a mapping of
        CUSIP → resolved ticker symbol for every match that has a symbol.
        """
        unique = list({c.upper().strip() for c in cusips if c})
        if not unique:
            return {}

        if self._symbol_property is None:
            self._discover_symbol_property()

        url = f"https://api.notion.com/v1/databases/{self.database_id}/query"
        resolved: dict[str, str] = {}
        found = 0

        for i in range(0, len(unique), 100):
            batch = unique[i : i + 100]
            filter_body = {
                "or": [
                    {"property": "cusip", "rich_text": {"equals": c}}
                    for c in batch
                ]
            }

            has_more = True
            start_cursor: Optional[str] = None

            while has_more:
                payload: dict = {"filter": filter_body, "page_size": 100}
                if start_cursor:
                    payload["start_cursor"] = start_cursor

                resp = self._session.post(
                    url, headers=self._headers(), json=payload
                )
                resp.raise_for_status()
                data = resp.json()

                for page in data.get("results", []):
                    props = page.get("properties", {})
                    cusip_val = self._extract_text_prop(props, "cusip")
                    if not cusip_val:
                        continue
                    symbol = self._extract_symbol(props)
                    omni = self._extract_omni(props)
                    key = cusip_val.upper().strip()
                    self.restrictions[key] = {
                        "symbol": symbol.upper() if symbol else key,
                        "resolved_ticker": symbol.upper() if symbol else None,
                        "omni_l_3": omni,
                        "page_id": page["id"],
                    }
                    if symbol:
                        resolved[key] = symbol.upper().strip()
                    found += 1

                has_more = data.get("has_more", False)
                start_cursor = data.get("next_cursor")

        log.info(
            "Notion CUSIP query: %d of %d CUSIP(s) found",
            found,
            len(unique),
        )
        return resolved

    @staticmethod
    def _extract_text_prop(props: dict, key: str) -> str:
        """Extract a text value from a Notion property by name."""
        raw = props.get(key, {})
        ptype = raw.get("type", "")
        if ptype == "rich_text":
            parts = raw.get("rich_text", [])
            return " ".join(p.get("plain_text", "") for p in parts).strip()
        if ptype == "title":
            parts = raw.get("title", [])
            return parts[0].get("plain_text", "").strip() if parts else ""
        if ptype == "select":
            sel = raw.get("select")
            return sel["name"] if sel else ""
        return str(raw.get(ptype, "")).strip() if ptype else ""

    @staticmethod
    def _extract_symbol(props: dict) -> str:
        """Extract the ticker symbol from the 'symbol' rich_text property,
        falling back to the title property if 'symbol' doesn't exist."""
        sym_raw = props.get("symbol", {})
        if sym_raw.get("type") == "rich_text":
            parts = sym_raw.get("rich_text", [])
            if parts:
                return parts[0].get("plain_text", "").strip()

        for _key, val in props.items():
            if val.get("type") == "title":
                parts = val.get("title", [])
                if parts:
                    return parts[0].get("plain_text", "").strip()
        return ""

    @staticmethod
    def _extract_omni(props: dict) -> str:
        """Extract the omni_l_3 column value (handles multiple Notion types)."""
        raw = props.get("omni_l_3", {})
        ptype = raw.get("type", "")

        if ptype == "rich_text":
            parts = raw.get("rich_text", [])
            return parts[0]["plain_text"].strip() if parts else ""
        if ptype == "select":
            sel = raw.get("select")
            return sel["name"] if sel else ""
        if ptype == "multi_select":
            return ", ".join(s["name"] for s in raw.get("multi_select", []))
        # Fallback for formula / rollup / plain string
        return str(raw.get(ptype, "")).strip()

    # -- public API ---------------------------------------------------------
    def check_symbol(self, symbol: str) -> dict:
        """
        Check a mutual fund symbol against the Notion restriction list.

        The "Omni" Rule:
          - Symbol found + omni_l_3 == "Omni"  → Transferrable (ACAT eligible)
          - Symbol found + omni_l_3 != "Omni"  → REVIEW (verify transferability)
          - Symbol NOT found                   → Unknown (caller should REVIEW)
        """
        sym = symbol.upper().strip()
        row = self.restrictions.get(sym)

        if row is None:
            return {
                "in_notion": False,
                "omni_l_3": None,
                "transferrable": None,
                "override_action": None,
                "override_reason": None,
            }

        omni_val = (row.get("omni_l_3") or "").strip()
        is_omni = omni_val.upper() == "OMNI"

        return {
            "in_notion": True,
            "omni_l_3": omni_val,
            "transferrable": is_omni,
            "override_action": None if is_omni else "REVIEW",
            "override_reason": None if is_omni else "Non-Omni mutual fund — verify transferability",
        }


# ---------------------------------------------------------------------------
# Notion reference database – custodian database
# ---------------------------------------------------------------------------
class NotionCustodianDB:
    """
    Custodian intelligence database (backed by Notion).

    Stores DTCC numbers, ACAT timelines, contact info, operational notes,
    and known name variations for each custodian. Loaded into memory on
    init for fast lookups during processing.

    Expected Notion DB properties:
      - Custodian           → title property (e.g., "Fidelity")
      - DTC                 → DTCC/OCC participant number
      - Anticipated Timeline → expected transfer duration (e.g., "5-7 business days")
      - Contact Information → transfer desk phone/email/details
      - Specific Details    → operational quirks, past experience notes
    """

    def __init__(self, api_key: str, database_id: str):
        self.api_key = api_key.strip()
        self.database_id = database_id.strip()
        self.custodians: dict[str, dict] = {}   # normalized name → row data
        self._alias_map: dict[str, str] = {}    # alias → canonical name
        self._session = _build_retry_session()
        self._load()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _normalize(name: str) -> str:
        """Lowercase, strip common suffixes for fuzzy matching."""
        n = name.lower().strip()
        for suffix in (
            ", inc.", ", inc", " inc.", " inc", ", llc", " llc",
            ", lp", " lp", " & co.", " & co", " co.", " corp.",
            " corp", " corporation", " securities", " investments",
            " brokerage services", " brokerage", " financial",
            " wealth management", " advisor services",
        ):
            if n.endswith(suffix):
                n = n[: -len(suffix)].strip()
        return n

    def _load(self):
        """Page through the Notion custodian DB and cache locally."""
        url = f"https://api.notion.com/v1/databases/{self.database_id}/query"
        has_more = True
        start_cursor: Optional[str] = None
        count = 0

        while has_more:
            payload: dict = {"page_size": 100}
            if start_cursor:
                payload["start_cursor"] = start_cursor

            resp = self._session.post(url, headers=self._headers(), json=payload)
            resp.raise_for_status()
            data = resp.json()

            for page in data.get("results", []):
                props = page.get("properties", {})
                name = self._extract_title(props)
                if not name:
                    continue

                row = {
                    "name": name,
                    "dtcc_number": self._extract_text(props, "DTC"),
                    "acat_timeline": self._extract_text(props, "Anticipated Timeline"),
                    "contact_info": self._extract_text(props, "Contact Information"),
                    "details": self._extract_text(props, "Specific Details"),
                }

                norm = self._normalize(name)
                self.custodians[norm] = row

                # Register the canonical name as its own alias
                self._alias_map[norm] = norm

                count += 1

            has_more = data.get("has_more", False)
            start_cursor = data.get("next_cursor")

        log.info("Custodian DB loaded: %d custodians cached", count)

    @staticmethod
    def _extract_title(props: dict) -> str:
        """Pull the first title-type property value."""
        for _key, val in props.items():
            if val.get("type") == "title":
                parts = val.get("title", [])
                if parts:
                    return parts[0].get("plain_text", "").strip()
        return ""

    @staticmethod
    def _extract_text(props: dict, key: str) -> str:
        """Extract a text value from various Notion property types."""
        raw = props.get(key, {})
        ptype = raw.get("type", "")

        if ptype == "rich_text":
            parts = raw.get("rich_text", [])
            return " ".join(p.get("plain_text", "") for p in parts).strip()
        if ptype == "title":
            parts = raw.get("title", [])
            return parts[0].get("plain_text", "").strip() if parts else ""
        if ptype == "number":
            val = raw.get("number")
            return str(val) if val is not None else ""
        if ptype == "phone_number":
            return raw.get("phone_number", "") or ""
        if ptype == "email":
            return raw.get("email", "") or ""
        if ptype == "select":
            sel = raw.get("select")
            return sel["name"] if sel else ""
        if ptype == "url":
            return raw.get("url", "") or ""
        # Fallback
        return str(raw.get(ptype, "")).strip() if ptype else ""

    def lookup(self, custodian_name: str) -> Optional[dict]:
        """
        Look up a custodian by name, trying exact match then fuzzy.

        Returns the custodian row dict or None if not found.

        Match strategy (in order):
          1. Exact normalized match against canonical names
          2. Exact normalized match against registered aliases
          3. Substring match — custodian_name contains a known name, or
             a known name contains custodian_name
        """
        if not custodian_name:
            return None

        norm = self._normalize(custodian_name)

        # 1. Direct match on canonical name
        if norm in self.custodians:
            return self.custodians[norm]

        # 2. Alias map
        canonical = self._alias_map.get(norm)
        if canonical:
            return self.custodians.get(canonical)

        # 3. Substring matching (handles "Fidelity Investments Inc."
        #    matching against "fidelity" in the DB)
        for known_norm, row in self.custodians.items():
            if known_norm in norm or norm in known_norm:
                return row

        return None


# ---------------------------------------------------------------------------
# Notion reference database – ticker / security classification database
# ---------------------------------------------------------------------------
class NotionTickerDB:
    """
    Security classification database (backed by Notion).

    Queries Notion on-demand for ticker symbols extracted from statements,
    returning asset type (Equity, ETF, Mutual Fund, etc.) and exchange.
    Uses batch OR-filter queries, same pattern as NotionRestrictionDB.

    Expected Notion DB properties:
      - Ticker     → title or rich_text (e.g., "AAPL")
      - Asset Type → select or rich_text (e.g., "Equity")
      - Exchange   → select or rich_text (e.g., "NASDAQ")
      - Name       → rich_text (e.g., "Apple Inc.")
    """

    def __init__(self, api_key: str, database_id: str):
        self.api_key = api_key.strip()
        self.database_id = database_id.strip()
        self.tickers: dict[str, dict] = {}  # SYMBOL -> {name, asset_type, exchange}
        self._session = _build_retry_session()
        self._ticker_property: Optional[str] = None
        self._ticker_prop_type: Optional[str] = None

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        }

    def _discover_ticker_property(self):
        """Fetch the database schema to find the property that holds ticker symbols."""
        url = f"https://api.notion.com/v1/databases/{self.database_id}"
        resp = self._session.get(url, headers=self._headers())
        resp.raise_for_status()
        props = resp.json().get("properties", {})

        for name, prop in props.items():
            if name.lower() == "ticker":
                self._ticker_property = name
                self._ticker_prop_type = prop["type"]
                return

        for name, prop in props.items():
            if prop.get("type") == "title":
                self._ticker_property = name
                self._ticker_prop_type = "title"
                return

        raise ValueError("No ticker or title property found in Notion ticker database")

    def query_symbols(self, symbols: list[str]):
        """
        Query Notion for a batch of ticker symbols. Results are cached
        in self.tickers for subsequent lookup() calls.
        """
        unique_symbols = list({s.upper().strip() for s in symbols if s})
        if not unique_symbols:
            return

        if self._ticker_property is None:
            self._discover_ticker_property()

        url = f"https://api.notion.com/v1/databases/{self.database_id}/query"
        found = 0

        for i in range(0, len(unique_symbols), 100):
            batch = unique_symbols[i : i + 100]
            filter_body = {
                "or": [
                    {
                        "property": self._ticker_property,
                        self._ticker_prop_type: {"equals": sym},
                    }
                    for sym in batch
                ]
            }

            has_more = True
            start_cursor: Optional[str] = None

            while has_more:
                payload: dict = {"filter": filter_body, "page_size": 100}
                if start_cursor:
                    payload["start_cursor"] = start_cursor

                resp = self._session.post(
                    url, headers=self._headers(), json=payload
                )
                resp.raise_for_status()
                data = resp.json()

                for page in data.get("results", []):
                    props = page.get("properties", {})
                    ticker = self._extract_text(props, "Ticker") or self._extract_title(props)
                    if not ticker:
                        continue
                    self.tickers[ticker.upper().strip()] = {
                        "name": self._extract_text(props, "Name"),
                        "asset_type": self._extract_text(props, "Asset Type"),
                        "exchange": self._extract_text(props, "Exchange"),
                    }
                    found += 1

                has_more = data.get("has_more", False)
                start_cursor = data.get("next_cursor")

        log.info(
            "Ticker DB queried: %d of %d symbol(s) found",
            found,
            len(unique_symbols),
        )

    def lookup(self, symbol: str) -> Optional[dict]:
        """Return cached ticker data or None."""
        return self.tickers.get((symbol or "").upper().strip())

    @staticmethod
    def _extract_title(props: dict) -> str:
        for _key, val in props.items():
            if val.get("type") == "title":
                parts = val.get("title", [])
                if parts:
                    return parts[0].get("plain_text", "").strip()
        return ""

    @staticmethod
    def _extract_text(props: dict, key: str) -> str:
        raw = props.get(key, {})
        ptype = raw.get("type", "")
        if ptype == "rich_text":
            parts = raw.get("rich_text", [])
            return " ".join(p.get("plain_text", "") for p in parts).strip()
        if ptype == "title":
            parts = raw.get("title", [])
            return parts[0].get("plain_text", "").strip() if parts else ""
        if ptype == "select":
            sel = raw.get("select")
            return sel["name"] if sel else ""
        return str(raw.get(ptype, "")).strip() if ptype else ""


# ---------------------------------------------------------------------------
# Notion reference database – Apex rules database
# ---------------------------------------------------------------------------
#: Apex rules whose keywords describe *security-level* concepts (e.g. bonds,
#: mutual fund families, hedge funds) and are therefore safe to match against
#: an asset's canonical type via `lookup_asset`. Every other rule is an
#: account-level rule and must NOT apply to individual positions — otherwise
#: account-level keywords like "cash" or "fixed income" accidentally fire on
#: canonical asset types with the same name.
_APEX_ASSET_RULE_LABELS: frozenset[str] = frozenset({
    "Fixed Income / Bond Accounts",
    "Mutual Fund Companies (Victory Funds/Capital, T. Rowe Price, First Command)",
    "Hedge funds",
})


def _infer_apex_rule_scope(account_type_label: str) -> str:
    """Return 'asset' for asset-level Apex rules, 'account' otherwise."""
    return "asset" if account_type_label in _APEX_ASSET_RULE_LABELS else "account"


class NotionApexRulesDB:
    """
    Apex account/asset rules database (backed by Notion).

    Loads rules on init for fast lookups. Supports:
      - Unsupported: block account or override asset to LIQUIDATE
      - Special Handling: flag for review, attach notes

    Expected Notion DB properties (from apex_rules.csv import):
      - Account Type      → title property
      - Rule Type         → select: "Unsupported" | "Special Handling"
      - Match Keywords    → rich_text: comma-separated (e.g., "trust, revocable trust")
      - Special Handling  → rich_text: notes/instructions

    Each rule also carries a `scope` of "account" or "asset", inferred from
    its Account Type label. This prevents account-level keywords (e.g.
    "cash" for Checking/Savings/Cash Accounts) from accidentally matching
    asset-level lookups for canonical asset types like "Cash".
    """

    def __init__(self, api_key: str, database_id: str):
        self.api_key = api_key
        self.database_id = database_id
        self.rules: list[dict] = []  # each: account_type, rule_type, keywords, notes
        self._session = _build_retry_session()
        self._prop_map: dict[str, str] = {}  # canonical name -> Notion property name
        self._load()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        }

    def _discover_properties(self, sample_props: dict) -> None:
        """Map logical names to actual Notion property names (handle renames)."""
        # Common variants from CSV import
        candidates = {
            "account_type": ["Account Type", "Name"],
            "rule_type": ["Rule Type"],
            "match_keywords": ["Match Keywords", "Match Keywords "],
            "special_handling": ["Special Handling", "Special Handling "],
        }
        for logical, names in candidates.items():
            for n in names:
                if n in sample_props:
                    self._prop_map[logical] = n
                    break

    def _extract_title(self, props: dict) -> str:
        """Pull the first title-type property value."""
        for key, val in props.items():
            if val.get("type") == "title":
                parts = val.get("title", [])
                if parts:
                    return parts[0].get("plain_text", "").strip()
        return ""

    def _extract_text(self, props: dict, key: str) -> str:
        """Extract text from rich_text, title, select, etc."""
        prop_name = self._prop_map.get(key) or key.replace("_", " ").title()
        raw = props.get(prop_name, {})
        ptype = raw.get("type", "")

        if ptype == "rich_text":
            parts = raw.get("rich_text", [])
            return " ".join(p.get("plain_text", "") for p in parts).strip()
        if ptype == "title":
            parts = raw.get("title", [])
            return parts[0].get("plain_text", "").strip() if parts else ""
        if ptype == "select":
            sel = raw.get("select")
            return sel["name"] if sel else ""
        return str(raw.get(ptype, "")).strip() if ptype else ""

    def _load(self) -> None:
        """Page through the Notion Apex rules DB and cache locally."""
        url = f"https://api.notion.com/v1/databases/{self.database_id}/query"
        has_more = True
        start_cursor: Optional[str] = None
        count = 0

        while has_more:
            payload: dict = {"page_size": 100}
            if start_cursor:
                payload["start_cursor"] = start_cursor

            resp = self._session.post(url, headers=self._headers(), json=payload)
            resp.raise_for_status()
            data = resp.json()

            for page in data.get("results", []):
                props = page.get("properties", {})
                if not self._prop_map:
                    self._discover_properties(props)

                account_type = self._extract_title(props) or self._extract_text(
                    props, "account_type"
                )
                if not account_type:
                    continue

                rule_type_raw = self._extract_text(props, "rule_type")
                rule_type = (rule_type_raw or "").strip().upper()
                if rule_type not in ("UNSUPPORTED", "SPECIAL HANDLING"):
                    rule_type = "SPECIAL HANDLING"  # default

                keywords_raw = self._extract_text(props, "match_keywords")
                keywords = [
                    k.strip().lower()
                    for k in (keywords_raw or "").split(",")
                    if k.strip()
                ]
                notes = self._extract_text(props, "special_handling")

                self.rules.append({
                    "account_type": account_type,
                    "rule_type": rule_type,
                    "keywords": keywords if keywords else [account_type.lower()],
                    "notes": notes,
                    "scope": _infer_apex_rule_scope(account_type),
                })
                count += 1

            has_more = data.get("has_more", False)
            start_cursor = data.get("next_cursor")

        log.info("Apex Rules DB loaded: %d rule(s) cached", count)

    def _lookup(self, needle: str, allowed_scopes: tuple[str, ...]) -> Optional[dict]:
        """A rule of the given scope(s) with a keyword that appears in *needle* as a whole word or phrase. Only
        that direction: the needle inside a longer keyword ("savings" in "college savings", "ira" in
        "inherited ira") matched the wrong rule, and so did a keyword inside a longer word ("rsu" in
        "pursuant")."""
        if not needle:
            return None
        haystack = needle.strip().lower()

        for rule in self.rules:
            if rule.get("scope", "account") not in allowed_scopes:
                continue
            for kw in rule["keywords"]:
                if re.search(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", haystack):
                    return rule
        return None

    def lookup_account(self, account_type: str) -> Optional[dict]:
        """
        Find an account-level rule matching the given account type.

        Uses keyword substring matching against rules whose scope is
        "account". Returns the first match.
        """
        return self._lookup(account_type, allowed_scopes=("account",))

    def lookup_asset(self, asset_type: str) -> Optional[dict]:
        """
        Find an asset-level rule matching the given position's asset type.

        Only asset-scoped rules (Fixed Income, Mutual Fund Companies, Hedge
        funds) are considered. This prevents account-level rules whose
        keywords happen to match an asset-type name (e.g. "cash" for
        Checking/Savings/Cash Accounts) from misclassifying individual
        positions inside an investment account.
        """
        return self._lookup(asset_type, allowed_scopes=("asset",))


# ---------------------------------------------------------------------------
# Gemini – document analysis (PDF, PNG, JPEG)
# ---------------------------------------------------------------------------
GEMINI_PROMPT = """\
You are a document data extractor. Analyze this brokerage statement
(PDF or image) and extract all data into the JSON structure below.

IMPORTANT: A single statement may contain MULTIPLE accounts (e.g., a
household statement showing an IRA, a Joint account, and a Roth IRA).
If the statement contains multiple accounts, return a JSON ARRAY of
objects — one per account. Each account MUST have its own complete
metadata and its own positions list. Do NOT merge positions from
different accounts. If only one account, return a single JSON object.

CRITICAL — one holding belongs to exactly ONE account. NEVER copy the
same holding into more than one account, and NEVER put every holding of
the statement into every account. Each position appears in the positions
list of the single account that actually holds it, and nowhere else.

SHARED INVESTOR NUMBER (e.g. T. Rowe Price mutual-fund statements): some
custodians group several registrations — for example a Roth IRA and a
Rollover/Traditional IRA — under ONE investor number, with NO separate
account number per registration. In that case:
  * Determine each account's holdings from the per-account holdings/
    "Portfolio Overview" summary section, and from the registration
    label ("Roth IRA", "Rollover IRA", etc.) printed next to each fund in
    the transaction-activity section. Assign every holding to the one
    registration it is listed under.
  * The transaction-activity section repeats each fund; do NOT let that
    repetition make you list a fund under both registrations.
  * Put the shared investor number in "investor_number" on every account,
    and the registration label in "account_registration". These are how
    the two accounts are told apart when "account_number" is null.

Per-account schema:

{
  "custodian": "<brokerage / custodian name as printed>",
  "account_number": "<full account number if visible, else null>",
  "investor_number": "<shared investor / client number if the statement uses ONE number across several registrations (e.g. T. Rowe Price), else null>",
  "account_registration": "<the per-account registration label that distinguishes this account from its siblings under the same investor number — e.g. 'Roth IRA', 'Rollover IRA'; else null>",
  "account_type_raw": "<account type exactly as printed on statement, INCLUDING any beneficiary/inherited/BDA designation if present anywhere on the statement for this account — e.g. 'Traditional IRA - Beneficiary', 'Inherited Roth IRA'>",
  "account_holder": "<the account owner / registered holder name(s) exactly as printed — the person(s) the account belongs to; for joint accounts include all owners; else null>",
  "statement_date": "<date if visible, else null>",
  "statement_portfolio_total": "<the statement-wide total portfolio value as printed (e.g. 'Total Portfolio Value', 'Mutual Fund Portfolio Value', Activity Summary 'Ending Value'), covering ALL accounts on the statement; copy the SAME value onto every account object from this statement; null if none is printed>",
  "positions": [
    {
      "symbol": "<ticker symbol or CUSIP exactly as printed>",
      "description": "<full security description as printed>",
      "quantity": <total shares held as a number or null>,
      "market_value": <total market value as a number or null>,
      "cost_basis": <total cost/tax basis for the whole position as printed, or null if not shown>,
      "lots": [
        {
          "acquisition_date": "<acquisition / purchase date exactly as printed, else null>",
          "quantity": <shares in this lot as a number or null>,
          "cost_basis": <cost/tax basis for this lot as printed, or null>,
          "market_value": <market value of this lot as printed, or null>
        }
      ]
    }
  ],
  "cash_balance": <number or null>,
  "total_value": <number or null>
}

CRITICAL EXTRACTION RULES:
- Extract EVERY position in EVERY account. Do NOT skip any holdings.
- CURRENT PERIOD ONLY: statements frequently print two value columns side
  by side — a beginning-of-period / prior-period value (e.g. "12/31/25
  Value", "Beginning Value", "Prior Period") next to the current
  period-end value (e.g. "03/31/26 Value", "Ending Value", "This Period").
  ALWAYS extract the CURRENT period-end quantity and market value — the
  column matching the statement's ENDING date. NEVER read the
  beginning-of-period or prior-period column. This applies to every
  position, every account total, and the statement portfolio total.
- For each position, report the AGGREGATE total (total shares and
  total market value) at the top level of the position. Report ONE
  entry per unique security per account with the combined total
  quantity and total market value. The lot-level breakdown (if any)
  goes in the "lots" array described below — never as separate
  top-level position entries.
- Include ALL asset types: common and preferred stock, ETFs, mutual funds, bonds,
  money market funds, alternatives, private equity, limited
  partnerships, annuities, structured products, and any other
  holdings shown.
- Cash vs. money market funds — read this carefully:
  * Report ONLY bare cash / sweep CASH balances that have NO ticker symbol
    in the "cash_balance" field (e.g. "Cash", "Free Credit Balance", "Sweep").
  * Money market FUNDS that have a real ticker symbol ARE securities (e.g.
    SPAXX, VMFXX, and any 5-letter ticker ending in XX such as IJMXX, TFDXX).
    You MUST list EACH of them as its own entry in the "positions" array with
    its ticker and market value. NEVER roll a ticker'd money market fund into
    "cash_balance".
  * If a statement's cash / money-market subtotal bundles ticker'd money
    market funds together with bare cash, SPLIT them: each ticker'd fund
    becomes its own position, and "cash_balance" holds ONLY the remaining
    bare cash (subtotal minus the ticker'd money market funds).
- Copy text exactly as printed — do NOT interpret or classify.
- Preserve preferred-stock series designations, ticker suffixes, and the
  full description (including depositary-share wording). Do not replace a
  preferred security's symbol with the issuer's common-stock symbol.
- If a value is partially obscured or ambiguous, extract what you can.

TAX-LOT / SUMMARY ROW RULES:
- Many statements list individual tax lots (with acquisition date, cost
  basis, etc.) followed by a TOTAL or SUMMARY row for that position
  showing the aggregate quantity and market value.
- The top-level "quantity" and "market_value" are ALWAYS the position
  aggregate: when a total/summary row exists, use THAT row's quantity and
  market value; if NO total row exists, sum the individual lot rows.
- NEVER add the individual lot rows as their own top-level position entries
  alongside the aggregate — that would double-count market value.

COST BASIS RULES (capture whatever granularity the statement provides):
- If the statement lists individual tax lots for a position (each with an
  acquisition/purchase date and/or a per-lot cost basis), put EACH lot in
  that position's "lots" array with its acquisition_date, quantity,
  cost_basis, and market_value (copy exactly as printed; use null for any
  field not shown). Also set the top-level "cost_basis" to the position's
  total cost basis (the printed total if shown, otherwise the sum of the
  lot cost bases).
- If the statement shows only a SINGLE cost basis for the whole position
  (no per-lot breakdown), set the top-level "cost_basis" to that value and
  leave "lots" empty ([]).
- If NO cost basis is shown for a position at all, set "cost_basis" to null
  and leave "lots" empty. Do NOT infer, estimate, or compute a cost basis.
- Cost basis may be labeled "Cost Basis", "Total Cost", "Tax Cost",
  "Adjusted Cost Basis", or "Book Value" — treat these as cost_basis.
- Positions may SPAN PAGE BREAKS. A position's lots may start on one page
  and continue (or show its total row) on the next page. Track each
  security and all its lots across ALL pages before finalizing.

BOND / FIXED INCOME EXTRACTION RULES:
- Individual bonds often appear WITHOUT a ticker symbol. If only a CUSIP
  is printed, use it as the "symbol". If neither a ticker nor a CUSIP is
  visible, set "symbol" to null.
- Each distinct bond (unique issuer + coupon + maturity) MUST be its own
  position entry — do NOT merge different bonds together.
- For bonds, use the par / face value as "quantity" (e.g., 35000).
- Include the FULL description as printed, preserving coupon rate,
  maturity date, DTD (dated date), credit ratings (S&P, Moody's, Fitch),
  and rate type (fixed, floating). Do NOT truncate or summarize.

Return ONLY valid JSON. No markdown fences, no commentary.
"""


def _repair_json(raw: str) -> str:
    """Best-effort repair of malformed JSON from Gemini (trailing commas,
    truncated output, unbalanced brackets).

    Strategy: if simple fixes don't work, progressively trim from the end
    to find the last valid object boundary, then close brackets."""
    s = raw.strip()
    # Remove trailing commas before } or ]
    s = re.sub(r",\s*([}\]])", r"\1", s)

    # Quick check — maybe that's all we needed
    try:
        json.loads(s)
        return s
    except json.JSONDecodeError:
        pass

    # Truncation repair: find the last complete value boundary and close up.
    # Walk backwards to find the last '}' or ']' that could end a complete
    # object/array, trim everything after it, then re-balance.
    for i in range(len(s) - 1, 0, -1):
        if s[i] in "}]":
            candidate = s[: i + 1]
            # Re-balance any remaining open brackets
            opens = candidate.count("[") - candidate.count("]")
            braces = candidate.count("{") - candidate.count("}")
            candidate += "}" * max(braces, 0)
            candidate += "]" * max(opens, 0)
            # Remove trailing commas created by the trim
            candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
            try:
                json.loads(candidate)
                return candidate
            except json.JSONDecodeError:
                continue

    return s


def analyze_document_with_gemini(
    file_path: str,
    mime_type: str = "application/pdf",
    model_name: str = "gemini-3.5-flash",
) -> list[dict]:
    """Upload a document to Vertex AI Gemini and return structured extractions.

    Supports PDF, PNG, and JPEG inputs. Returns a list of account dicts —
    one per account found in the document. Multi-account statements produce
    multiple entries; single-account statements produce a one-element list.

    Requires _init_genai() to have been called first.
    """
    with open(file_path, "rb") as f:
        doc_bytes = f.read()

    doc_part = types.Part.from_bytes(data=doc_bytes, mime_type=mime_type)
    log.info("  Loaded %s (%d KB, %s) for Vertex AI", os.path.basename(file_path), len(doc_bytes) // 1024, mime_type)

    is_thinking_model = "2.5" in model_name or "preview" in model_name or model_name.startswith("gemini-3")
    gen_config = types.GenerateContentConfig(
        temperature=0.0,
        http_options=types.HttpOptions(timeout=600 * 1000),
    )
    if is_thinking_model:
        # Give the model enough thinking room to track positions across
        # pages and reconcile lot-level detail vs summary rows.
        gen_config.thinking_config = types.ThinkingConfig(thinking_budget=16384)
    else:
        gen_config.max_output_tokens = 8192

    max_retries = 4
    base_delay = 5  # seconds
    retryable_codes = ("429", "504", "DEADLINE_EXCEEDED", "503", "UNAVAILABLE", "RESOURCE_EXHAUSTED")
    for attempt in range(1, max_retries + 1):
        try:
            chunks = []
            t0 = time.time()
            for chunk in _genai_client.models.generate_content_stream(
                model=model_name,
                contents=[doc_part, GEMINI_PROMPT],
                config=gen_config,
            ):
                if chunk.text:
                    chunks.append(chunk.text)
            elapsed = time.time() - t0
            response_text = "".join(chunks)
            log.info("  Gemini responded in %.1fs (%d stream chunks, %d chars)", elapsed, len(chunks), len(response_text))
            break
        except Exception as exc:
            exc_str = str(exc)
            if any(code in exc_str for code in retryable_codes) and attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                log.warning("  Retryable error on attempt %d/%d — retrying in %ds: %s", attempt, max_retries, delay, exc_str[:200])
                time.sleep(delay)
            else:
                raise

    raw = response_text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
    if raw.endswith("```"):
        raw = raw.rsplit("```", 1)[0]
    raw = raw.strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # Attempt JSON repair: trailing commas, truncated output, etc.
        repaired = _repair_json(raw)
        try:
            parsed = json.loads(repaired)
            log.warning("  Gemini JSON required repair — parsed after cleanup")
        except json.JSONDecodeError as exc2:
            log.error("Gemini returned invalid JSON (repair failed): %s", exc2)
            log.debug("Raw response (first 2000 chars):\n%s", raw[:2000])
            return [{"error": str(exc2), "raw_response": raw}]

    # Normalize to a list — Gemini returns a single object or an array
    if isinstance(parsed, dict):
        accounts = [parsed]
    elif isinstance(parsed, list):
        accounts = [a for a in parsed if isinstance(a, dict)]
    else:
        return [{"error": "Unexpected response type", "raw_response": raw}]

    if not accounts:
        return [{"error": "Empty response from Gemini", "raw_response": raw}]

    # Remap Gemini's "positions" key to "assets" for downstream compatibility,
    # and accept either key so the pipeline works with both prompt versions.
    valid = []
    for acct in accounts:
        if "positions" in acct and "assets" not in acct:
            acct["assets"] = acct.pop("positions")
        if not isinstance(acct.get("assets"), list):
            log.warning(
                "  Skipping account missing positions list: %s",
                acct.get("account_number", "unknown"),
            )
            continue
        valid.append(acct)

    if not valid:
        log.error("No valid accounts extracted from document")
        return [{"error": "No valid accounts with positions", "raw_response": raw}]

    # Consolidate tax lots into single positions per symbol per account
    for acct in valid:
        acct["assets"] = _consolidate_lots(acct.get("assets", []))

    for acct in valid:
        num_assets = len(acct.get("assets", []))
        log.info(
            "  Account %s (%s): %d positions, total_value=%s",
            acct.get("account_number", "N/A"),
            acct.get("custodian", "N/A"),
            num_assets,
            acct.get("total_value"),
        )

    if len(valid) > 1:
        log.info("  Multi-account statement: %d accounts extracted", len(valid))

    return valid


def _safe_float(val) -> float:
    """Coerce a value to float, handling None, strings with $ and commas."""
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    cleaned = str(val).replace(",", "").replace("$", "").strip()
    try:
        return float(cleaned)
    except (ValueError, TypeError):
        return 0.0


def _safe_float_or_none(val) -> Optional[float]:
    """Like _safe_float but preserves "not provided" as None.

    Cost basis must distinguish a real $0 from a missing value, so we never
    coerce None / blank / unparseable input to 0.0 here.
    """
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    cleaned = str(val).replace(",", "").replace("$", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except (ValueError, TypeError):
        return None


def _clean_lots(raw_lots) -> list[dict]:
    """Normalize a position's raw "lots" list into clean lot dicts.

    Drops entirely-empty lot rows; preserves acquisition_date and
    null-vs-value distinction for cost_basis / market_value.
    """
    if not isinstance(raw_lots, list):
        return []
    cleaned: list[dict] = []
    for lot in raw_lots:
        if not isinstance(lot, dict):
            continue
        acq = lot.get("acquisition_date")
        qty = _safe_float_or_none(lot.get("quantity"))
        basis = _safe_float_or_none(lot.get("cost_basis"))
        mv = _safe_float_or_none(lot.get("market_value"))
        if acq is None and qty is None and basis is None and mv is None:
            continue
        cleaned.append({
            "acquisition_date": acq,
            "quantity": round(qty, 4) if qty is not None else None,
            "cost_basis": round(basis, 2) if basis is not None else None,
            "market_value": round(mv, 2) if mv is not None else None,
        })
    return cleaned


def _position_total_basis(row: dict, lots: list[dict]) -> Optional[float]:
    """Resolve a position's total cost basis.

    Prefers the explicit printed top-level cost_basis. Otherwise sums the
    lot cost bases — but if ANY lot is missing its basis, returns None
    rather than silently undercounting.
    """
    explicit = _safe_float_or_none(row.get("cost_basis"))
    if explicit is not None:
        return round(explicit, 2)
    if lots:
        lot_bases = [lot.get("cost_basis") for lot in lots]
        if any(b is None for b in lot_bases):
            return None
        return round(sum(lot_bases), 2)
    return None


def _rows_as_lots(rows: list[dict]) -> list[dict]:
    """Treat a set of flat per-symbol rows as tax lots.

    Defensive fallback for the legacy case where the model emits separate
    top-level rows per lot (acquisition_date/cost_basis on each) instead of
    nesting them under a single position. Used only when a position has no
    nested "lots" of its own.
    """
    return _clean_lots([
        {
            "acquisition_date": r.get("acquisition_date"),
            "quantity": r.get("quantity"),
            "cost_basis": r.get("cost_basis"),
            "market_value": r.get("market_value"),
        }
        for r in rows
    ])


def _finalize_position(row: dict, sym: str, lots: list[dict]) -> dict:
    """Attach cost_basis + lots to a consolidated position and round totals."""
    row["symbol"] = sym
    row["quantity"] = round(_safe_float(row.get("quantity")), 4)
    row["market_value"] = round(_safe_float(row.get("market_value")), 2)
    row["lots"] = lots
    row["cost_basis"] = _position_total_basis(row, lots)
    return row


def _consolidate_lots(assets: list[dict]) -> list[dict]:
    """Merge tax lots with the same symbol into a single position.

    When multiple rows share a symbol, checks whether one row already
    represents the total of the others (i.e., the statement printed a
    summary row alongside individual lots).  If so, keeps only the
    summary row to avoid double-counting.  Otherwise, sums all rows.

    Cost basis is preserved: each position carries a "lots" list (lot-level
    detail when the statement provided it) and a "cost_basis" total. Lot
    detail nested under the source rows is carried through; if the model
    instead emitted flat per-lot rows, they are folded back into "lots".
    """
    grouped: dict[str, list[dict]] = {}
    no_symbol: list[dict] = []
    for a in assets:
        sym = (a.get("symbol") or "").strip().upper()
        if not sym or sym in ("N/A", "\u2014", "--", ""):
            a["lots"] = _clean_lots(a.get("lots"))
            a["cost_basis"] = _position_total_basis(a, a["lots"])
            no_symbol.append(a)
            continue
        grouped.setdefault(sym, []).append(a)

    consolidated: list[dict] = []
    for sym, rows in grouped.items():
        nested_lots: list[dict] = []
        for r in rows:
            nested_lots.extend(_clean_lots(r.get("lots")))

        if len(rows) == 1:
            consolidated.append(_finalize_position(rows[0], sym, nested_lots))
            continue

        values = [_safe_float(r.get("market_value")) for r in rows]
        total_all = sum(values)

        # Check if any single row's value ≈ sum of the remaining rows,
        # indicating it is a pre-printed total/summary row.
        found_total = False
        for i, v in enumerate(values):
            others = total_all - v
            if v > 0 and others > 0 and abs(v - others) / v < 0.01:
                row = {**rows[i], "symbol": sym}
                # Prefer the summary row's own nested lots; else the lots
                # nested on siblings; else treat the sibling rows as lots.
                lots = (
                    _clean_lots(rows[i].get("lots"))
                    or nested_lots
                    or _rows_as_lots([r for j, r in enumerate(rows) if j != i])
                )
                consolidated.append(_finalize_position(row, sym, lots))
                found_total = True
                log.debug(
                    "  %s: detected summary row (%.2f) among %d rows — "
                    "using summary instead of summing",
                    sym, v, len(rows),
                )
                break

        if not found_total:
            base = {
                **rows[0],
                "symbol": sym,
                "quantity": round(
                    sum(_safe_float(r.get("quantity")) for r in rows), 4
                ),
                "market_value": round(
                    sum(_safe_float(r.get("market_value")) for r in rows), 2
                ),
            }
            # No summary row: rows are either page-split partials (carry their
            # nested lots) or the lots themselves (fold the rows into lots).
            lots = nested_lots or _rows_as_lots(rows)
            # The summed base must not keep a stale single-row cost_basis;
            # derive the total from the lots instead.
            base.pop("cost_basis", None)
            consolidated.append(_finalize_position(base, sym, lots))

    return consolidated + no_symbol


# ---------------------------------------------------------------------------
# Deterministic classification engine
# ---------------------------------------------------------------------------

# ── Account type normalization ────────────────────────────────────────────

_ACCOUNT_TYPE_MAP: list[tuple[list[str], str, bool]] = [
    # (keywords, canonical_type, is_rollover)
    # Order matters — first match wins.  More specific patterns before generic.
    (["inherited roth", "beneficiary roth", "bda roth", "bene roth"],
      "Inherited Roth IRA", False),
    (["inherited ira", "beneficiary ira", "bda ira", "bda",
      "bene ira", "bene trad", "inherited"], "Inherited IRA", False),
    (["roth ira", "rothira", "roth individual retirement"], "Roth IRA", False),
    (["sep ira", "sep-ira", "simplified employee pension"], "SEP IRA", True),
    (["simple ira", "simple-ira"], "SIMPLE IRA", True),
    (["traditional ira", "trad ira", "rollover ira", "ira rollover", "individual retirement"], "IRA", False),
    (["ira"], "IRA", False),
    (["401k", "401(k)"], "401k", True),
    (["403b", "403(b)"], "403b", True),
    (["457b", "457(b)", "457"], "457b", True),
    (["thrift savings", "tsp"], "TSP", True),
    (["profit sharing", "profit-sharing"], "Profit-Sharing Plan", True),
    (["money purchase"], "Money Purchase Plan", True),
    (["defined benefit", "pension"], "Defined Benefit Plan", True),
    (["529"], "529", False),
    (["joint", "jtwros", "joint tenants", "tenants in common"], "Joint", False),
    (["trust", "revocable trust", "irrevocable trust", "living trust"], "Trust", False),
    (["custodial", "ugma", "utma"], "Custodial", False),
    # An education account, not a bank savings account: no canonical type of its own, so the per-asset rules
    # decide, rather than the savings rule sending every position by ACH or wire.
    (["coverdell", "education savings"], "Other", False),
    (["savings", "high yield savings", "high-yield savings",
      "hy savings", "online savings", "bank savings"], "Savings", False),
    (["checking", "bank checking"], "Checking", False),
    (["cma", "cash management", "cash management account"], "CMA", False),
    (["annuity", "annuities", "variable annuity", "fixed annuity"], "Annuity", False),
    # Employee Stock Plans / RSUs / ESPP must come BEFORE the generic
    # "individual/brokerage" bucket: E*TRADE Stock Plan statements often
    # say "Stock Plan" and would otherwise fall through to "Other" or
    # collide with brokerage keywords.
    (["stock plan", "employee stock", "espp", "rsu", "restricted stock"],
      "Employee Stock Plan", False),
    (["individual", "individ", "taxable", "brokerage", "margin",
      "tod", "transfer on death"], "Individual", False),
]

_ROLLOVER_TYPES = frozenset(
    canonical for _, canonical, is_rollover in _ACCOUNT_TYPE_MAP if is_rollover
)

_INHERITED_TYPES = ("Inherited IRA", "Inherited Roth IRA")

CANONICAL_ACCOUNT_TYPES = (
    {canonical for _, canonical, _ in _ACCOUNT_TYPE_MAP}
    | {"Other"}
    | set(_INHERITED_TYPES)
)

# Canonical account types whose holdings have a taxable cost basis (and thus
# feed the downstream tax transition analysis). Tax-advantaged accounts
# (IRA/Roth/401k/403b/457b/SEP/SIMPLE/TSP/529/pensions) and bank accounts
# (Savings/Checking) do not — cost basis is not required for them.
TAXABLE_ACCOUNT_TYPES = frozenset({
    "Individual", "Joint", "Trust", "Custodial", "CMA",
})


def normalize_account_type(raw: str) -> tuple[str, bool]:
    """
    Normalize a raw account type string (as printed on a statement) into a
    canonical type.

    Returns (canonical_type, is_rollover).
    """
    lowered = (raw or "").strip().lower()
    if not lowered:
        return "Other", False

    # Inherited / beneficiary accounts: detect regardless of word order.
    # Statements print these in many formats ("Traditional IRA - Beneficiary",
    # "Roth IRA (Inherited)", "BDA IRA", etc.) so a simple presence check
    # before the keyword loop prevents misclassification as a generic IRA.
    # "Designated beneficiary" (or "Designated Bene") names a transfer-on-death designation on the owner's own
    # account, so it doesn't count; and "beneficiary" or "bene" alone marks an inherited account only beside a
    # retirement word ("Bene IRA", "Traditional IRA - Beneficiary").
    marked = lowered.replace("designated beneficiary", "").replace("designated bene", "")
    retirement = any(w in marked for w in ("ira", "roth", "401", "403", "retirement"))
    if (any(m in marked for m in ("inherited", "bda"))
            or (retirement and any(m in marked for m in ("beneficiary", "bene ")))):
        if "roth" in lowered:
            return "Inherited Roth IRA", False
        return "Inherited IRA", False

    for keywords, canonical, is_rollover in _ACCOUNT_TYPE_MAP:
        for kw in keywords:
            if kw in lowered:
                return canonical, is_rollover

    return "Other", False


# ── Accounts-to-be-opened: destination type + auto-seed ────────────────────

def _map_destination_type(account_type: Optional[str]) -> str:
    """Map a source account's canonical type to the destination (Apex) account
    type label. Retirement plans (401k/403b/IRA/rollover) land in a Traditional
    IRA; Roth-flavored in a Roth IRA; joints in a Joint; everything else Individual."""
    canon = pipeline_db.normalize_acct_type(account_type) or "INDIVIDUAL"
    inherited = " INHERITED" in canon
    base = canon.replace(" INHERITED", "")
    label = {
        "INDIVIDUAL": "Individual",
        "JOINT": "Joint",
        "ROTH IRA": "Roth IRA",
        "TRAD IRA": "Traditional IRA",
    }.get(base, (base.title() if base else "Individual"))
    return label + (" (Inherited)" if inherited else "")


def _live_open_apex_number(warehouse: "Optional[WarehouseClient]", owner: Optional[str],
                           type_norm: Optional[str]) -> Optional[str]:
    """If the client already has an OPEN Apex account of this type in the live
    investment DB, return its custodian_account_number (else None).

    The roster is a snapshot that can lag or omit accounts (e.g. a spouse in
    the same household, or an account opened since the last feed). This queries
    the authoritative investment DB by name so a genuinely-open account isn't
    mislabeled "needs to be opened". Best-effort: any miss returns None.

    Joints ("A & B") are resolved by querying each named participant — the
    investment DB returns the shared joint account for either owner, so we try
    them in turn and take the first participant whose full name resolves."""
    if not (warehouse and owner and type_norm):
        return None
    # Split a joint owner into its participants; a single owner is a 1-item list.
    participants = [p.strip() for p in owner.split("&")] if "&" in owner else [owner.strip()]
    for part in participants:
        toks = [t for t in re.split(r"\s+", part) if t]
        if len(toks) < 2:
            continue  # can't form first+last (e.g. shared-surname "John" in "John & Owen Ashby")
        first, last = toks[0], toks[-1]
        for row in warehouse.open_accounts_by_name(first, last):
            if pipeline_db.normalize_acct_type(row.get("account_type")) == type_norm:
                num = row.get("custodian_account_number")
                if num:
                    return num
    return None


def _seed_destination_accounts(db_conn, source_folder_id: str, accounts: list,
                               warehouse: "Optional[WarehouseClient]" = None) -> int:
    """Auto-seed a 1:1 draft destination per extracted source account, keyed by
    (custodian, account_number). Idempotent across re-runs: a source already
    linked (e.g. from a prior run, possibly reassigned by Ops) is left untouched.

    needs_to_be_opened starts from the roster suggestion, then falls back to
    the live investment DB (via `warehouse`) when the roster has no match — this catches
    accounts that are genuinely OPEN at Apex but missing from the roster feed
    (see ticket). `warehouse` defaults to WarehouseClient.from_env()."""
    if warehouse is None:
        warehouse = WarehouseClient.from_env()
    seeded = 0
    for acct in accounts:
        custodian = acct.get("custodian")
        acct_num = acct.get("account_number")
        if pipeline_db.get_link_target(db_conn, source_folder_id, custodian, acct_num):
            continue  # already mapped — preserve Ops edits
        owner = acct.get("account_holder")
        dtype = _map_destination_type(acct.get("account_type"))
        type_norm = pipeline_db.normalize_acct_type(dtype)
        matches = pipeline_db.query_roster(
            db_conn, pipeline_db.normalize_owner(owner), type_norm,
        )
        needs = len(matches) == 0
        existing_apex_number = None
        if needs:
            # Roster missed it — check the authoritative investment DB before
            # declaring the account must be opened.
            existing_apex_number = _live_open_apex_number(warehouse, owner, type_norm)
            if existing_apex_number:
                needs = False
        target_id = pipeline_db.create_target_account(
            db_conn, source_folder_id, owner, dtype, needs_to_be_opened=needs,
            existing_apex_number=existing_apex_number, user="auto",
        )
        pipeline_db.link_source(db_conn, source_folder_id, custodian, acct_num, target_id, user="auto")
        seeded += 1
    return seeded


# ── Asset type classification ─────────────────────────────────────────────

_MONEY_MARKET_KEYWORDS = {
    "MONEY MARKET", "MONEY MKT", "MM FUND", "MMF",
    "CASH RESERVE", "CASH MANAGEMENT", "CASH FUND",
    "GOVERNMENT CASH", "TREASURY CASH", "PRIME CASH",
    "SETTLEMENT FUND", "SWEEP",
    "FDIC", "SPAXX", "FDRXX", "FZFXX", "VMFXX", "VMMXX",
    "SWVXX", "SNVXX", "TTTXX", "SPRXX",
}

_BOND_KEYWORDS = {
    "BOND", "NOTE", "TREASURY", "T-BILL", "T-BOND", "T-NOTE",
    "FIXED INCOME", "MUNICIPAL", "MUNI", "DEBENTURE",
    "CORPORATE BOND", "GOVT BOND", "GOVERNMENT BOND",
    "DTD", "FLG RATE", "FLOATING RATE", "MATURITY",
    "COUPON", "PAR VALUE", "FACE VALUE",
}

_ETF_KEYWORDS = {
    "ETF", "EXCHANGE TRADED", "EXCHANGE-TRADED",
    "ISHARES", "SPDR", "VANGUARD ETF", "PROSHARES",
    "INVESCO QQQ", "SCHWAB ETF",
}

_ALTERNATIVE_KEYWORDS = {
    "PRIVATE EQUITY", "PRIVATE ASSETS", "PRIVATE FUND",
    "HEDGE FUND", "FUND OF FUNDS",
    "LIMITED PARTNERSHIP", "LP INTEREST", "L.P.",
    "VENTURE CAPITAL", "VENTURE FUND",
    "REAL ESTATE FUND", "REIT FUND", "NON-TRADED REIT",
    "INTERVAL FUND", "TENDER OFFER FUND",
    "STRUCTURED NOTE", "STRUCTURED PRODUCT",
    "ANNUITY", "VARIABLE ANNUITY", "FIXED ANNUITY",
    "ALTERNATIVE", "ALT INVESTMENT",
    "DIRECT INVESTMENT", "DIRECT PARTICIPATION",
    "COMMODITY POOL", "MANAGED FUTURES",
    "PAF", "HAMILTON LANE", "BLACKSTONE", "KKR FUND",
    "CARLYLE", "APOLLO FUND",
}

_ANNUITY_KEYWORDS = {
    "ANNUITY", "VARIABLE ANNUITY", "FIXED ANNUITY",
    "INDEXED ANNUITY", "DEFERRED ANNUITY",
}

_PREFERRED_DESC_PATTERN = re.compile(
    r"\b(?:PREFERRED[\s-]+(?:STOCK|STK|SHARES?|SHS)|PFD|PREF)\b",
    re.IGNORECASE,
)


def _classify_preferred_description(symbol: str, description: str) -> Optional[str]:
    """Recognize explicit preferred wording without relabeling related products.

    No inference from ticker punctuation or series suffixes: common share
    classes use those too. This runs before bond/CUSIP fallbacks because a
    preferred can have a CUSIP, dividend rate, and credit rating on a statement.
    """
    if not _PREFERRED_DESC_PATTERN.search(description):
        return None
    if any(kw in description for kw in ("CALL OPTION", "PUT OPTION", "OPTIONS")):
        return "Option"
    if any(kw in description for kw in _ANNUITY_KEYWORDS):
        return "Annuity"
    if any(kw in description for kw in _ALTERNATIVE_KEYWORDS):
        return "Alternative"
    if re.fullmatch(r"[A-Z]{4}X", symbol) or "MUTUAL FUND" in description:
        return "Mutual Fund"
    if any(kw in description for kw in _ETF_KEYWORDS):
        return "ETF"
    # A generic fund/portfolio label does not identify the fund's structure.
    if re.search(r"\b(?:FUNDS?|PORTFOLIO|INDEX)\b", description):
        return "Other"
    # A note, warrant, or common share referring to preferred stock is a
    # different instrument. Let the existing rules handle it.
    if re.search(r"\b(?:NOTES?|BONDS?|DEBENTURES?|WARRANTS?|RIGHTS?|COMMON|ORDINARY)\b", description):
        return None
    return "Preferred Stock"


_OPTION_PATTERN = re.compile(
    r"(\d{6}[CP]\d+)|(\d{2}/\d{2}/\d{2,4}\s+(call|put))|(\s\d+(\.\d+)?\s+(call|put))",
    re.IGNORECASE,
)

_BOND_DESC_PATTERN = re.compile(
    r"""
    (?:\d+\.\d+\s*%)                        # coupon rate like "5.4500%" or "3.45%"
    |(?:DTD\s+\d{1,2}/\d{1,2}/\d{2,4})      # dated date
    |(?:FLG\s+RATE)                          # floating rate indicator
    |(?:MOODY'?S:\s*[A-C][a-z0-9]+)         # Moody's rating
    |(?:S&P:\s*[A-D][+-]?)                   # S&P rating
    |(?:FITCH:\s*[A-D][+-]?)                 # Fitch rating
    """,
    re.VERBOSE | re.IGNORECASE,
)


def _looks_like_bond_description(desc: str) -> bool:
    """Return True if the description matches >=2 bond-like patterns
    (coupon, dated-date, ratings, floating-rate indicator)."""
    return len(_BOND_DESC_PATTERN.findall(desc)) >= 2


def classify_asset_type(
    position: dict, ticker_db: Optional["NotionTickerDB"] = None
) -> tuple[str, str]:
    """
    Classify a position's asset type deterministically.

    Returns (asset_type, classification_source) where source is one of
    "ticker_db", "heuristic", "multi_ticker", or "fallback".
    """
    sym = (position.get("symbol") or "").upper().strip()
    desc = (position.get("description") or "").upper()
    combined = f"{sym} {desc}"

    # Tier 0: Cash / no symbol
    if not sym or sym in ("N/A", "CASH", "—", "--", ""):
        if any(kw in combined for kw in _MONEY_MARKET_KEYWORDS):
            return "Cash", "heuristic"
        if any(kw in desc for kw in ("CASH", "BALANCE", "SWEEP")):
            return "Cash", "heuristic"
        preferred_type = _classify_preferred_description(sym, desc)
        if preferred_type:
            return preferred_type, "heuristic"
        if any(kw in desc for kw in _BOND_KEYWORDS):
            return "Fixed Income", "heuristic"
        if _looks_like_bond_description(desc):
            return "Fixed Income", "heuristic"
        if any(kw in desc for kw in _ALTERNATIVE_KEYWORDS):
            return "Alternative", "heuristic"
        return "Other", "fallback"

    # Tier 0.5: Money market (check before ticker DB — these sometimes
    # have 5-letter symbols that could look like mutual funds)
    if any(kw in combined for kw in _MONEY_MARKET_KEYWORDS):
        return "Cash", "heuristic"

    # Tier 0.7: Multi-ticker / asset-class rows. Robo-advisor statements
    # (e.g. Betterment) group several ETFs under a single line, putting a
    # comma-separated list in the symbol field ("VTI, SCHB, VTV"). That
    # combined string never matches the single-ticker DB and falls through to
    # "Other". Split it, classify each constituent through the normal path,
    # and combine conservatively: only auto-clear when EVERY constituent is a
    # standard transferable security; otherwise route to manual review.
    sub_tickers = [t.strip() for t in sym.split(",") if t.strip()]
    if len(sub_tickers) > 1:
        sub_types = {
            classify_asset_type({"symbol": t, "description": desc}, ticker_db)[0]
            for t in sub_tickers
        }
        if sub_types <= {"Equity", "ETF"}:
            return ("ETF" if "ETF" in sub_types else "Equity"), "multi_ticker"
        if sub_types == {"Preferred Stock"}:
            return "Preferred Stock", "multi_ticker"
        return "Other", "multi_ticker"

    # Tier 1: Ticker DB lookup
    _TICKER_DB_TYPE_MAP = {
        "CS": "Equity",
        "COMMON STOCK": "Equity",
        "STOCK": "Equity",
        "ORDINARY SHARES": "Foreign Equity",
        "ADR": "Equity",
        "REIT": "Equity",
        "PFD": "Preferred Stock",
        "PREF": "Preferred Stock",
        "PREFERRED STOCK": "Preferred Stock",
        "PREFERRED SHARES": "Preferred Stock",
        "WARRANT": "Equity",
        "ETV": "ETF",
        "CEF": "ETF",
        "CLOSED-END FUND": "ETF",
        "CLOSED END FUND": "ETF",
        "ETP": "ETF",
        "ETN": "ETF",
    }
    if ticker_db is not None:
        match = ticker_db.lookup(sym)
        if match and match.get("asset_type"):
            raw_type = match["asset_type"].strip()
            normalized = _TICKER_DB_TYPE_MAP.get(raw_type.upper(), raw_type)
            return normalized, "ticker_db"

    # Tier 2: Heuristic rules

    # Options (symbol matches options notation, or description has option keywords)
    if _OPTION_PATTERN.search(sym):
        return "Option", "heuristic"
    if " " in sym and any(c.isdigit() for c in sym):
        return "Option", "heuristic"
    if any(kw in desc for kw in ("CALL OPTION", "PUT OPTION", "OPTIONS")):
        return "Option", "heuristic"

    preferred_type = _classify_preferred_description(sym, desc)
    if preferred_type:
        return preferred_type, "heuristic"

    # Fixed income / bonds — but ONLY when there is no clean exchange ticker.
    # A 1-4 letter ticker is a listed security (e.g. the bond ETFs MUB, TFI,
    # AGG, BND) that transfers in-kind via ACAT. Individual bonds appear as
    # CUSIPs or untickered text, so a bond-y *description* (e.g. "U.S.
    # Municipal Bonds" on a bond ETF) must not downgrade a real ticker to
    # Fixed Income / LIQUIDATE.
    is_listed_ticker = bool(re.match(r"^[A-Z]{1,4}$", sym))
    if not is_listed_ticker:
        if any(kw in desc for kw in _BOND_KEYWORDS):
            return "Fixed Income", "heuristic"
        if _looks_like_bond_description(desc):
            return "Fixed Income", "heuristic"

    # CUSIP format (9 alphanumeric chars) — likely a bond or structured product
    if re.match(r"^[A-Z0-9]{9}$", sym) and not sym.isalpha():
        return "Fixed Income", "heuristic"

    # Mutual funds: 5 letters ending in X (US convention)
    if re.match(r"^[A-Z]{5}$", sym) and sym[-1] == "X":
        return "Mutual Fund", "heuristic"

    # OTC 5th-character suffix conventions (FINRA naming rules):
    #   F = Foreign Ordinary Share — typically not DTC-eligible
    #   Q = Bankruptcy proceedings
    #   E = Delinquent SEC filings
    #   Y = ADR (American Depositary Receipt) — sponsored ADRs are usually
    #       DTC-eligible, but unsponsored Pink Sheet ADRs (e.g., DNNGY) are
    #       not. Without a Notion DB entry to confirm, route to REVIEW.
    if re.match(r"^[A-Z]{5}$", sym):
        suffix = sym[-1]
        if suffix == "F":
            return "Foreign Equity", "heuristic"
        if suffix in ("Q", "E"):
            return "OTC Restricted", "heuristic"
        if suffix == "Y":
            return "Foreign ADR", "heuristic"

    # ETFs by description keywords
    if any(kw in desc for kw in _ETF_KEYWORDS):
        return "ETF", "heuristic"

    # Annuities (check before alternatives — more specific)
    if any(kw in desc for kw in _ANNUITY_KEYWORDS):
        return "Annuity", "heuristic"

    # Alternative investments (private equity, hedge funds, LPs, etc.)
    if any(kw in desc for kw in _ALTERNATIVE_KEYWORDS):
        return "Alternative", "heuristic"

    # Standard US equity ticker (1-4 uppercase letters)
    if re.match(r"^[A-Z]{1,4}$", sym):
        return "Equity", "heuristic"

    # Multi-class share tickers like BRK'B, BRK.B, BRK/B
    if re.match(r"^[A-Z]{1,4}[.'/-][A-Z]$", sym):
        return "Equity", "heuristic"

    # Tier 3: Fallback
    return "Other", "fallback"


# ── Transfer eligibility classification ───────────────────────────────────

def classify_transfer_eligibility(
    asset: dict,
    account_type: str,
    is_rollover: bool,
    notion_check: Optional[dict],
    apex_acct_rule: Optional[dict],
    apex_asset_rule: Optional[dict],
) -> tuple[str, str]:
    """
    Determine transfer eligibility for a single position.

    Returns (transfer_eligible, transfer_notes). Pure deterministic logic
    with an explicit priority chain.
    """
    asset_type = (asset.get("type") or "Other").strip()
    symbol = (asset.get("symbol") or "").upper().strip()

    # Layer 1: Apex account-level block → UNSUPPORTED
    if apex_acct_rule and apex_acct_rule.get("rule_type") == "UNSUPPORTED":
        reason = apex_acct_rule.get("notes") or f"Account type not supported: {account_type}"
        return "UNSUPPORTED", f"Apex Rules: {reason}"

    # Layer 1b: Employee Stock Plan accounts → UNSUPPORTED
    #   Product decision (ticket): unvested/restricted stock plan holdings
    #   cannot be ACAT'd; vested shares usually force a partial ACAT that is
    #   handled separately. Flag the entire account as unsupported so Ops
    #   routes it through manual paperwork.
    if account_type == "Employee Stock Plan":
        return "UNSUPPORTED", (
            "Routing Rule: Employee Stock Plan / RSU account — unvested or "
            "restricted holdings cannot be transferred via ACAT; requires "
            "manual paperwork at the sending custodian"
        )

    # Layer 2: Rollover accounts → all positions liquidated and transferred as cash
    if is_rollover:
        return "LIQUIDATE", f"Rollover Rule: {account_type} — must liquidate and transfer as cash"

    # Layer 3: Inherited/beneficiary IRAs → REVIEW (titling issues)
    if account_type in _INHERITED_TYPES:
        return "REVIEW", (
            f"Inherited Account: {account_type} — requires manual review "
            "due to potential titling issues that prevent standard ACAT transfer"
        )

    # Layer 4: Bank accounts → all positions route via ACH/wire
    bank_types = ("Savings", "Checking", "Bank Account")
    if account_type in bank_types:
        return "ACH/WIRE", "Routing Rule: Bank account — must be transferred via ACH or wire"

    # Layer 5: Apex asset-level block → LIQUIDATE
    if apex_asset_rule and apex_asset_rule.get("rule_type") == "UNSUPPORTED":
        reason = apex_asset_rule.get("notes") or f"Asset type not supported: {asset_type}"
        return "LIQUIDATE", f"Apex Rules: {reason}"

    # Layer 6: Apex asset-level special handling → REVIEW
    if apex_asset_rule and apex_asset_rule.get("rule_type") == "SPECIAL HANDLING":
        reason = apex_asset_rule.get("notes") or f"Special handling required: {asset_type}"
        return "REVIEW", f"Apex Rules: {reason}"

    # Layer 7: Cash in investment accounts → transfers with the account
    if asset_type == "Cash":
        return "ACAT", "Routing Rule: Cash balance in investment account — transfers with ACAT"

    # Layer 8: Mutual fund Notion check
    if asset_type == "Mutual Fund":
        if notion_check is None or not notion_check.get("in_notion"):
            return "REVIEW", f"Notion DB: Mutual fund {symbol} not found in restriction list — verify transferability"
        if notion_check.get("transferrable"):
            return "ACAT", f"Notion DB: Confirmed {symbol} transferable (Omni)"
        return "REVIEW", f"Notion DB: {symbol} is non-Omni mutual fund — verify transferability"

    # Layer 9: Fixed income → LIQUIDATE
    if asset_type == "Fixed Income":
        return "LIQUIDATE", "Routing Rule: Apex does not support in-kind bond transfers — must liquidate"

    # Layer 10: Options → REVIEW (may be exercisable or need special handling)
    if asset_type == "Option":
        return "REVIEW", "Routing Rule: Option contract — requires manual review for exercise/expiry status"

    # Layer 11: Alternatives (PE, hedge funds, LPs) → REVIEW
    if asset_type == "Alternative":
        return "REVIEW", "Routing Rule: Alternative/private investment — requires manual review"

    # Layer 12: Annuities → REVIEW
    if asset_type == "Annuity":
        return "REVIEW", "Routing Rule: Annuity contract — requires manual review"

    # Layer 13: OTC foreign ordinary shares → REVIEW (likely not DTC-eligible)
    if asset_type == "Foreign Equity":
        return "REVIEW", (
            f"OTC Flag: {symbol} appears to be a foreign ordinary share "
            "(5-letter ticker ending in F) — may not be DTC-eligible for ACAT transfer"
        )

    # Layer 14: OTC restricted securities (bankruptcy / SEC delinquent) → REVIEW
    if asset_type == "OTC Restricted":
        return "REVIEW", (
            f"OTC Flag: {symbol} has a restricted OTC suffix "
            "(Q = bankruptcy, E = delinquent SEC filings) — requires manual review"
        )

    # Layer 14a: Heuristic-classified ADR not confirmed in ticker DB → REVIEW
    if asset_type == "Foreign ADR":
        return "REVIEW", (
            f"OTC Flag: {symbol} appears to be an ADR (5-letter ticker ending in Y) "
            "but is not confirmed in the ticker DB — verify DTC eligibility before "
            "ACAT (unsponsored Pink Sheet ADRs are often not DTC-eligible)"
        )

    # Layer 14b: Preferred stock. A reference-confirmed preferred previously
    # normalized to Equity and followed the standard ACAT path. Keep that
    # routing, subject to the account/Apex rules above. Description-only
    # evidence identifies the security type, not its transferability.
    if asset_type == "Preferred Stock":
        if asset.get("classification_source") == "ticker_db":
            return "ACAT", "Ticker DB: Preferred Stock — standard securities routing"
        return "REVIEW", (
            "Routing Rule: Preferred Stock not confirmed in the ticker DB — "
            "verify the security and DTC eligibility before ACAT transfer"
        )

    # Layer 15: Standard securities → ACAT
    if asset_type in ("Equity", "ETF"):
        return "ACAT", f"Ticker DB: Standard {asset_type} — auto-cleared"

    # Layer 16: Fallback — anything unclassified
    return "REVIEW", f"Routing Rule: Unclassified asset type ({asset_type}) — requires manual review"


def reclassify_for_new_account_type(
    new_account_type: str,
    apex_rules_db: Optional["NotionApexRulesDB"],
    positions: list[dict],
    account_type_other: Optional[str] = None,
    forced_review_note: Optional[str] = None,
) -> tuple[dict, list[dict]]:
    """
    Recompute account-level metadata and per-position transfer eligibility
    after an Ops user manually overrides the account_type.

    An account the validation step flagged (its values don't reconcile, or it
    duplicates another account) keeps every position in REVIEW: pass that
    note as `forced_review_note`. The engine's new answer is kept in
    `original_transfer_eligible`, as the pipeline does when it forces REVIEW.

    Reuses each position's already-extracted `asset_type`, stored
    `classification_source`, and `notion_check`, so no Notion / ticker /
    Gemini round-trips are required.
    Only the deterministic rule engine (`classify_transfer_eligibility`) is
    re-run.

    Args:
      new_account_type: One of `CANONICAL_ACCOUNT_TYPES`.
      apex_rules_db: Loaded NotionApexRulesDB, or None to skip Apex layers.
      positions: Iterable of dicts each carrying at least
        `id`, `symbol`, `asset_type` (or `type`), `classification_source`,
        and optional `notion_check`.

    Returns:
      (account_fields, position_updates) where:
        account_fields = {
          account_type, is_rollover, rollover_note,
          is_inherited, inherited_note, apex_restriction,
        }
        position_updates = [{id, transfer_eligible, transfer_notes}, ...]
    """
    is_rollover = new_account_type in _ROLLOVER_TYPES
    is_inherited = new_account_type in _INHERITED_TYPES

    rollover_note = (
        "Rollover account — all assets will be liquidated at the "
        "sending custodian and transferred as cash to the receiving account."
    ) if is_rollover else None

    inherited_note = (
        f"{new_account_type} — cannot be automatically transferred due to "
        "differing titling between institutions. Requires manual paperwork "
        "and processing to ensure exact titling match."
    ) if is_inherited else None

    apex_acct_rule = None
    if apex_rules_db is not None and getattr(apex_rules_db, "rules", None):
        apex_acct_rule = apex_rules_db.lookup_account(new_account_type)

    apex_restriction = None
    if apex_acct_rule and apex_acct_rule.get("rule_type") == "UNSUPPORTED":
        apex_restriction = (
            apex_acct_rule.get("notes")
            or f"Account type not supported: {new_account_type}"
        )

    position_updates: list[dict] = []
    for pos in positions:
        asset_type = (pos.get("asset_type") or pos.get("type") or "Other")
        asset_type = asset_type.strip() if isinstance(asset_type, str) else "Other"

        apex_asset_rule = None
        if apex_rules_db is not None and getattr(apex_rules_db, "rules", None):
            apex_asset_rule = apex_rules_db.lookup_asset(asset_type)

        new_status, new_notes = classify_transfer_eligibility(
            asset={
                "symbol": pos.get("symbol"), "type": asset_type,
                "classification_source": pos.get("classification_source"),
            },
            account_type=new_account_type,
            is_rollover=is_rollover,
            notion_check=pos.get("notion_check"),
            apex_acct_rule=apex_acct_rule,
            apex_asset_rule=apex_asset_rule,
        )
        if forced_review_note:
            position_updates.append({
                "id": pos["id"],
                "transfer_eligible": "REVIEW",
                "transfer_notes": forced_review_note,
                "original_transfer_eligible": new_status,
            })
        else:
            position_updates.append({
                "id": pos["id"],
                "transfer_eligible": new_status,
                "transfer_notes": new_notes,
            })

    # Free-text description is a human label only — kept solely for the
    # "Other" bucket and cleared when switching to any named type so a stale
    # description can't linger on a now-typed account. It does NOT drive the
    # rule engine; an "Other" account routes purely by per-asset rules.
    other_label = (account_type_other or "").strip() or None
    account_type_other_value = other_label if new_account_type == "Other" else None

    return (
        {
            "account_type": new_account_type,
            "account_type_other": account_type_other_value,
            "is_rollover": is_rollover,
            "rollover_note": rollover_note,
            "is_inherited": is_inherited,
            "inherited_note": inherited_note,
            "apex_restriction": apex_restriction,
        },
        position_updates,
    )


# ---------------------------------------------------------------------------
# Custodian intelligence enrichment
# ---------------------------------------------------------------------------
def enrich_with_custodian_data(
    analysis: dict, custodian_db: Optional["NotionCustodianDB"]
) -> dict:
    """
    Look up the sending custodian in the Custodian DB and attach operational
    intelligence (DTCC number, timeline, contact, notes) to the analysis.

    This runs AFTER all classification layers. It doesn't change any
    transfer_eligible values — it only adds context for the ops team.
    """
    if custodian_db is None:
        return analysis

    custodian_name = (analysis.get("custodian") or "").strip()
    if not custodian_name:
        return analysis

    match = custodian_db.lookup(custodian_name)

    if match:
        analysis["custodian_intel"] = {
            "matched_name": match["name"],
            "dtcc_number": match.get("dtcc_number") or None,
            "acat_timeline": match.get("acat_timeline") or None,
            "contact_info": match.get("contact_info") or None,
            "details": match.get("details") or None,
        }
        log.info(
            "    ✓ Custodian match: %s → DTCC %s, %s",
            custodian_name,
            match.get("dtcc_number", "N/A"),
            match.get("acat_timeline", "no timeline"),
        )
    else:
        analysis["custodian_intel"] = None
        log.info(
            "    ⚠ Custodian '%s' not found in Custodian DB", custodian_name
        )

    return analysis


# ---------------------------------------------------------------------------
# Pre-extraction document classification (lightweight Gemini call)
# ---------------------------------------------------------------------------

_CLASSIFY_DOC_PROMPT = """\
Classify this financial document. Scan ALL pages (not just the first) and
determine which category it belongs to. Return ONLY a JSON object (no markdown):

{
  "doc_type": "<one of the categories below>",
  "statement_date": "YYYY-MM-DD or null if not found",
  "confidence": "high" | "medium" | "low"
}

Categories (pick the single best match):
- "investment_statement" — A periodic brokerage or custodian account statement showing account holdings/positions with quantities and market values. IMPORTANT: Many statements begin with a summary or overview page and list detailed positions on later pages — these are still investment statements. If ANY page contains a list of holdings/positions with quantities and values, classify as investment_statement.
- "holdings_report" — A consolidated or per-account summary of ACTUAL current custodial holdings, listing positions with quantities and values (similar data to a statement but may span multiple accounts). Must reflect real held positions — NOT hypothetical, projected, or illustrative holdings.
- "account_summary" — ONLY use this if the document shows account balances and truly contains NO detailed position/holdings listings on ANY page
- "performance_report" — Investment performance, returns, growth, or projections over a period. This INCLUDES hypothetical portfolio illustrations and proposal/projection documents (e.g. Morningstar "Hypothetical Illustration", "Portfolio Snapshot", or "Portfolio X-Ray" reports; anything labeled "Hypothetical", "Illustration", "Prepared for", or showing "Net Amount Invested" / benchmark comparisons such as MSCI ACWI). Classify these as performance_report EVEN IF they list securities with quantities and values — the holdings are illustrative/projected, not actual custodial positions.
- "gains_losses" — Realized or unrealized capital gains and losses report that does NOT list live per-position quantities and market values (e.g. a realized-gains tax summary with totals only). If the document instead lists actual custodial positions with quantities AND market values on any page — even when it is titled/framed as a "Cost Basis" or "Gain/Loss" report and shows Unrealized Gain/(Loss) columns — classify it as investment_statement or holdings_report instead, per the tiebreak below.
- "fee_schedule" — Advisory, management, or custodian fee breakdown
- "trade_confirmation" — Individual trade or transaction confirmation
- "tax_form" — Tax documents (1099, 5498, K-1, etc.)
- "bank_statement" — Checking or savings account statement
- "other" — Anything that does not fit the categories above

When in doubt between "investment_statement" and another category, prefer "investment_statement".
HOWEVER, a hypothetical illustration, projection, or proposal is NEVER an investment_statement, holdings_report, or account_summary — even when it lists holdings — because it does not represent actual custodial positions. Classify those as performance_report.
Similarly, a cost-basis or gain/loss report that lists REAL per-lot quantities and market values for actual custodial holdings (e.g. a brokerage "Equity Cost Basis" statement with Quantity and Estimated Market Value columns) is an investment_statement or holdings_report, NOT gains_losses — reserve gains_losses for reports that show gain/loss figures WITHOUT live quantities or market values.
No markdown, no commentary — just the JSON object.
"""


def classify_document_with_gemini(
    file_path: str,
    mime_type: str = "application/pdf",
    model_name: str = "gemini-3.5-flash",
) -> dict:
    """Lightweight Gemini call to classify a document before full extraction.

    Returns {doc_type, statement_date, confidence}.
    """
    with open(file_path, "rb") as f:
        doc_bytes = f.read()

    doc_part = types.Part.from_bytes(data=doc_bytes, mime_type=mime_type)
    is_thinking_model = "2.5" in model_name or "preview" in model_name or model_name.startswith("gemini-3")
    gen_config = types.GenerateContentConfig(
        temperature=0.0,
        max_output_tokens=512,
        http_options=types.HttpOptions(timeout=60 * 1000),
    )
    if is_thinking_model:
        # Classification is a lightweight decision. Disable thinking so the token
        # budget produces the JSON answer instead of being consumed by reasoning.
        # Without this, gemini-3 spends the entire output budget thinking and
        # returns an empty response (finish_reason=MAX_TOKENS), which the except
        # block below silently degrades to doc_type="unknown" — disabling the
        # reject gate for EVERY document.
        gen_config.thinking_config = types.ThinkingConfig(thinking_budget=0)

    max_retries = 4
    base_delay = 5
    retryable_codes = ("429", "504", "DEADLINE_EXCEEDED", "503", "UNAVAILABLE", "RESOURCE_EXHAUSTED")

    for attempt in range(1, max_retries + 1):
        try:
            resp = _genai_client.models.generate_content(
                model=model_name,
                contents=[doc_part, _CLASSIFY_DOC_PROMPT],
                config=gen_config,
            )
            raw = (resp.text or "").strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1]
            if raw.endswith("```"):
                raw = raw.rsplit("```", 1)[0]
            raw = raw.strip()
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                repaired = _repair_json(raw)
                return json.loads(repaired)
        except Exception as exc:
            exc_str = str(exc)
            if any(code in exc_str for code in retryable_codes) and attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                log.warning("  Classification retry %d/%d in %ds: %s", attempt, max_retries, delay, exc_str[:200])
                time.sleep(delay)
            else:
                log.warning("  Document classification failed: %s", exc)
                return {"doc_type": "unknown", "statement_date": None, "confidence": "low"}


def _statement_age_days(date_str) -> Optional[int]:
    """Return the age of a statement date in days (>=0), or None if missing/unparseable.

    Handles plain dates and statement-period ranges, using the period END date
    (e.g. "February 1-28, 2026" -> Feb 28; "Jan 1 - Feb 28, 2026" -> Feb 28)."""
    if not date_str:
        return None
    s = str(date_str).strip()
    candidates = [s]
    # Same-month day range: "February 1-28, 2026" -> "February 28, 2026"
    m = re.match(r'^([A-Za-z]+)\.?\s+\d{1,2}\s*[-–]+\s*(\d{1,2}),?\s+(\d{4})$', s)
    if m:
        candidates.append(f"{m.group(1)} {m.group(2)}, {m.group(3)}")
    # Any dash range: try a trailing full date, then the chunk after the last dash
    if "-" in s or "–" in s:
        m2 = re.search(r'([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})\s*$', s)
        if m2:
            candidates.append(m2.group(1))
        candidates.append(re.split(r'[-–]', s)[-1].strip())
    for cand in candidates:
        cand = cand.strip().rstrip(",").strip()
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%B %d, %Y", "%b %d, %Y"):
            try:
                d = datetime.strptime(cand, fmt).replace(tzinfo=ET)
                return (datetime.now(ET) - d).days
            except ValueError:
                continue
    return None  # unparseable


def _is_date_recent(date_str: str, max_age_days: int = 60) -> bool:
    """Return True if the date string is within max_age_days of today.
    Missing/unparseable dates are treated as recent (can't determine)."""
    age = _statement_age_days(date_str)
    return age is None or age <= max_age_days


def statement_stale_days() -> int:
    """Freshness threshold in days. A statement older than this is flagged as
    stale (a non-blocking caveat surfaced in the UI), NOT dropped. Configurable
    via STATEMENT_STALE_DAYS; defaults to 60."""
    try:
        return int(os.getenv("STATEMENT_STALE_DAYS", "60"))
    except ValueError:
        return 60


def flag_statement_freshness(account: dict, *, stale_days: Optional[int] = None) -> Optional[int]:
    """Annotate an account with its statement age. Sets ``statement_age_days``
    (int or None) and ``is_stale`` (bool). Freshness is a flag, never a drop.
    Returns the age in days (or None when the date is missing/unparseable)."""
    threshold = stale_days if stale_days is not None else statement_stale_days()
    age = _statement_age_days(account.get("statement_date"))
    account["statement_age_days"] = age
    account["is_stale"] = bool(age is not None and age > threshold)
    return age


# Document types the pre-extraction gate will extract vs. reject.
_ALLOWED_DOC_TYPES = ("investment_statement", "holdings_report", "account_summary")
_REJECT_DOC_TYPES = (
    "performance_report", "gains_losses", "fee_schedule",
    "trade_confirmation", "tax_form", "bank_statement", "other",
)


def doc_classification_bypassed() -> bool:
    """True when BYPASS_DOC_CLASSIFICATION is set. When on, the pre-extraction
    classifier is skipped and every document is extracted regardless of doc type.

    Intended for controlled one-off backfills (e.g. ingesting account types the
    classifier normally rejects), NOT as a steady-state setting. Leave unset in
    normal operation. (Staleness is no longer a drop reason — see
    flag_statement_freshness — so this flag only affects doc-type rejection.)
    """
    return os.getenv("BYPASS_DOC_CLASSIFICATION", "").strip().lower() in ("1", "true", "yes", "on")


def evaluate_doc_gate(doc_type: str, *, bypass: bool):
    """Pure (side-effect-free) decision for the pre-extraction gate.

    Returns ``(decision, reason)`` where decision is 'process' or 'reject'.
    Rejection is by document TYPE only (tax forms, bank statements, etc.).
    Staleness is NOT a drop reason — old statements are extracted and flagged
    via flag_statement_freshness. When ``bypass`` is True, always 'process'.
    Kept separate from process_client_folder so it can be unit-tested.
    """
    if bypass:
        return "process", None
    if doc_type in _REJECT_DOC_TYPES:
        return "reject", (
            f"Document classified as '{doc_type}' — only statements and holdings reports are processed"
        )
    return "process", None


# ---------------------------------------------------------------------------
# Cash reconciliation — run BEFORE validation to prevent double-counting
# ---------------------------------------------------------------------------

def _is_cash_line_item(pos: dict) -> bool:
    """True only for literal cash/sweep entries, NOT money market funds.

    Money market funds with real ticker symbols (SPAXX, VMFXX, etc.)
    are securities and must remain in the positions array.
    """
    sym = (pos.get("symbol") or "").upper().strip()
    desc = (pos.get("description") or "").upper()

    if sym and sym not in ("CASH", "N/A", "", "--", "—", "NONE"):
        return False

    cash_terms = ("CASH", "SWEEP", "FREE CREDIT", "CREDIT BALANCE",
                  "CASH BALANCE", "CASH & EQUIV", "CASH AND EQUIV")
    return any(term in desc for term in cash_terms)


def _reconcile_cash(account: dict) -> None:
    """Ensure cash is counted exactly once per account.

    Gemini may report cash as both a top-level `cash_balance` AND as a
    position in the `assets` array. This function deduplicates:

    - If cash_balance > 0: strip literal cash line items from assets,
      then inject a single synthetic Cash position from cash_balance.
    - If cash_balance is 0/null but there are cash line items in assets:
      backfill cash_balance from those positions, leave them in place.
    - Money market funds with real tickers are never touched.
    """
    assets = account.get("assets", [])
    cash_balance = float(account.get("cash_balance") or 0)

    cash_line_items = [p for p in assets if _is_cash_line_item(p)]
    cash_from_positions = sum(float(p.get("market_value") or 0) for p in cash_line_items)

    if cash_balance > 0 and cash_line_items:
        # Both sources present — trust cash_balance, remove duplicates
        account["assets"] = [p for p in assets if not _is_cash_line_item(p)]
        account["assets"].append({
            "symbol": "CASH",
            "description": "Cash Balance",
            "quantity": None,
            "market_value": cash_balance,
        })
        if abs(cash_balance - cash_from_positions) > 0.01:
            log.info(
                "    Cash reconciliation: cash_balance=$%.2f vs position cash=$%.2f — using cash_balance",
                cash_balance, cash_from_positions,
            )
    elif cash_balance > 0:
        # cash_balance set but no cash positions — inject one
        account["assets"].append({
            "symbol": "CASH",
            "description": "Cash Balance",
            "quantity": None,
            "market_value": cash_balance,
        })
    elif cash_line_items:
        # No cash_balance but cash is in positions — backfill the field
        account["cash_balance"] = cash_from_positions
    # else: no cash at all — nothing to do


# ---------------------------------------------------------------------------
# Post-extraction validation
# ---------------------------------------------------------------------------

def validate_extraction(account: dict) -> tuple[str, list[str]]:
    """Validate an extracted account for data quality issues.

    Returns (validation_status, list_of_issues) where status is
    'VALID', 'WARNING', or 'INVALID'.
    """
    issues: list[str] = []

    # Value reconciliation: sum(position values) vs total_value
    # After _reconcile_cash(), cash is already represented as a position
    # in the assets array, so we only sum positions (no separate cash add).
    positions = account.get("assets", [])
    reported_total = float(account.get("total_value") or 0)
    computed_total = sum(
        float(p.get("market_value") or 0) for p in positions
    )

    if reported_total > 0 and computed_total > 0:
        delta = abs(reported_total - computed_total)
        pct = delta / reported_total
        if pct > 0.02:
            issues.append(
                f"Value mismatch: reported ${reported_total:,.2f} vs "
                f"computed ${computed_total:,.2f} (delta ${delta:,.2f}, {pct:.1%})"
            )

    # Required fields
    if not account.get("custodian"):
        issues.append("Missing custodian name")
    if not account.get("account_type_raw") and not account.get("account_type"):
        issues.append("Missing account type")
    if not positions:
        issues.append("No positions or cash balance extracted")

    # Statement freshness is handled separately (flag_statement_freshness) and
    # surfaced as its own UI badge — it is intentionally NOT an extraction issue.

    if not issues:
        return "VALID", []

    has_value_mismatch = any("Value mismatch" in i for i in issues)
    if has_value_mismatch or len(issues) >= 2:
        return "WARNING", issues

    return "VALID", issues


# ---------------------------------------------------------------------------
# Cost basis validation — run AFTER cash reconciliation
# ---------------------------------------------------------------------------

def _is_taxable_account(account: dict) -> bool:
    """True if the account's holdings carry a taxable cost basis.

    Uses the canonical account_type when present, else normalizes the raw
    type. Tax-advantaged and bank accounts return False.
    """
    canonical = account.get("account_type")
    if not canonical:
        canonical, _ = normalize_account_type(account.get("account_type_raw") or "")
    return canonical in TAXABLE_ACCOUNT_TYPES


def _position_has_basis(pos: dict) -> bool:
    """True if a position carries any cost basis (position total or lot-level)."""
    if pos.get("cost_basis") is not None:
        return True
    return any(lot.get("cost_basis") is not None for lot in (pos.get("lots") or []))


def validate_cost_basis(account: dict) -> tuple[str, list[str]]:
    """Tag cost-basis granularity per position and assess account coverage.

    Mutates each position with ``cost_basis_granularity`` ("lot" / "position"
    / None) and returns ``(cost_basis_status, issues)`` where status is one of
    NOT_APPLICABLE, COMPLETE, PARTIAL, or MISSING.

    Cost basis is informational for the downstream tax transition analysis —
    this never changes transfer_eligible or forces REVIEW.
    """
    issues: list[str] = []
    positions = account.get("assets", [])

    # Tag granularity on every position regardless of account type.
    for pos in positions:
        if pos.get("lots"):
            pos["cost_basis_granularity"] = "lot"
        elif pos.get("cost_basis") is not None:
            pos["cost_basis_granularity"] = "position"
        else:
            pos["cost_basis_granularity"] = None

        # Flag a lot-total vs position-total mismatch (data quality).
        lots = pos.get("lots") or []
        lot_bases = [lot.get("cost_basis") for lot in lots]
        explicit = pos.get("cost_basis")
        if lots and explicit is not None and lot_bases and all(b is not None for b in lot_bases):
            lot_sum = round(sum(lot_bases), 2)
            if explicit > 0 and abs(lot_sum - explicit) / explicit > 0.02:
                issues.append(
                    f"Cost basis mismatch for {pos.get('symbol') or pos.get('description') or 'position'}: "
                    f"lot total ${lot_sum:,.2f} vs position total ${explicit:,.2f}"
                )

    if not _is_taxable_account(account):
        return "NOT_APPLICABLE", issues

    # Cash is never expected to carry a cost basis — exclude it from coverage.
    securities = [p for p in positions if not _is_cash_line_item(p)]
    if not securities:
        return "NOT_APPLICABLE", issues

    missing = [p for p in securities if not _position_has_basis(p)]
    if not missing:
        status = "COMPLETE"
    elif len(missing) == len(securities):
        status = "MISSING"
    else:
        status = "PARTIAL"

    if missing:
        names = [p.get("symbol") or p.get("description") or "?" for p in missing]
        shown = ", ".join(names[:8]) + (f", +{len(names) - 8} more" if len(names) > 8 else "")
        issues.append(
            f"Cost basis missing for {len(missing)} of {len(securities)} "
            f"securities: {shown}"
        )

    return status, issues


# ---------------------------------------------------------------------------
# Consolidation & report assembly
# ---------------------------------------------------------------------------
_STOCK_PLAN_KEYWORDS = (
    "stock plan", "employee stock", "espp", "rsu", "restricted stock",
)


def _has_stock_plan_context(value: Optional[str]) -> bool:
    """True if a raw account-type string looks like an employee stock plan."""
    if not value:
        return False
    lowered = value.lower()
    return any(kw in lowered for kw in _STOCK_PLAN_KEYWORDS)


def _merge_duplicate_accounts(existing: dict, incoming: dict) -> dict:
    """Merge two per-PDF account extractions that resolve to the same account.

    Two regimes:

    * DIFFERENT statement dates — the copies are snapshots of the same account
      at different points in time (e.g. a current quarterly statement plus a
      prior year-end one for the same T. Rowe registration). The more recent
      snapshot is authoritative: take it wholesale rather than unioning stale
      positions and values in. This prevents an old statement's higher pre-
      decline values from overwriting the current ones.
    * SAME or missing dates — the copies are the same statement (duplicated
      file) or complementary reports for one account (a brokerage statement +
      an Employee Stock Plan report). Union their positions (dedup by symbol,
      preferring the larger market_value) and keep the larger total/cash so we
      never drop context just because one PDF had fewer rows.
    """
    age_e = _statement_age_days(existing.get("statement_date"))
    age_i = _statement_age_days(incoming.get("statement_date"))
    if age_e is not None and age_i is not None and age_e != age_i:
        newer, older = (incoming, existing) if age_i < age_e else (existing, incoming)
        merged = dict(newer)
        # Preserve stock-plan context if only the older copy carried it.
        if _has_stock_plan_context(older.get("account_type_raw") or "") and \
                not _has_stock_plan_context(newer.get("account_type_raw") or ""):
            merged["account_type_raw"] = older.get("account_type_raw")
            merged["account_type"] = older.get("account_type") or merged.get("account_type")
        return merged

    merged = dict(existing)

    # Prefer the raw account-type string that carries stock-plan context,
    # so downstream classification can recognize Employee Stock Plan accounts
    # even when the other PDF said "Individual Brokerage".
    existing_raw = existing.get("account_type_raw") or ""
    incoming_raw = incoming.get("account_type_raw") or ""
    if _has_stock_plan_context(incoming_raw) and not _has_stock_plan_context(existing_raw):
        merged["account_type_raw"] = incoming_raw
        merged["account_type"] = incoming.get("account_type") or merged.get("account_type")

    # Union positions by (symbol, description). When the same symbol appears
    # in both PDFs, keep the entry with the larger market_value — that's the
    # more complete extraction (e.g. full tax-lot rollup vs. summary row).
    def _pos_key(pos: dict) -> tuple:
        sym = (pos.get("symbol") or "").strip().upper()
        desc = (pos.get("description") or "").strip().lower()
        return (sym, desc) if sym else (sym, desc, id(pos))

    position_map: dict[tuple, dict] = {}
    for pos in (existing.get("assets") or []) + (incoming.get("assets") or []):
        k = _pos_key(pos)
        prior = position_map.get(k)
        if prior is None:
            position_map[k] = pos
            continue
        prior_mv = prior.get("market_value") or 0
        new_mv = pos.get("market_value") or 0
        if new_mv > prior_mv:
            position_map[k] = pos
    merged["assets"] = list(position_map.values())

    merged["total_value"] = max(
        existing.get("total_value") or 0,
        incoming.get("total_value") or 0,
    )
    merged["cash_balance"] = max(
        existing.get("cash_balance") or 0,
        incoming.get("cash_balance") or 0,
    )

    return merged


def _dedup_accounts(accounts: list[dict]) -> list[dict]:
    """Deduplicate accounts that resolve to the same real account, then merge.

    Identity, in priority order:
      1. account_number + custodian — the normal case.
      2. NO account number: investor_number + account_registration + custodian.
         Custodians like T. Rowe Price group several registrations (Roth IRA,
         Rollover IRA, ...) under ONE investor number with no per-account
         number. Multiple documents describing the SAME registration (duplicate
         files, or a current + a prior-period statement) must collapse to one
         account — otherwise they explode into duplicate account objects that
         trip the cross-account duplication guard and force the whole household
         to REVIEW. investor_number keys keep DIFFERENT people/registrations
         apart while merging copies of the same one.
      3. No account number and no investor number: never merged (keyed by id).

    Merging unions positions / prefers the most recent snapshot (see
    _merge_duplicate_accounts) and preserves stock-plan context.
    """
    seen: dict[tuple, dict] = {}
    for acct in accounts:
        num = (acct.get("account_number") or "").strip().upper()
        cust = (acct.get("custodian") or "").strip().upper()
        if num:
            key: tuple = ("NUM", num, cust)
        else:
            inv = (acct.get("investor_number") or "").strip().upper()
            reg = (acct.get("account_registration") or "").strip().upper()
            if inv:
                key = ("INV", inv, reg, cust)
            else:
                # No identity to match on — keep as its own account.
                seen[id(acct)] = acct
                continue

        existing = seen.get(key)
        if existing is None:
            seen[key] = acct
            continue

        existing_count = len(existing.get("assets") or [])
        new_count = len(acct.get("assets") or [])
        merged = _merge_duplicate_accounts(existing, acct)
        ident = key[1] if key[0] == "NUM" else f"{key[1]}|{key[2]}"
        log.info(
            "    ⚠ Dedup: %s %s at %s — merged %d + %d positions into %d (raw types: %r + %r)",
            key[0], ident, cust,
            existing_count, new_count, len(merged.get("assets") or []),
            existing.get("account_type_raw"), acct.get("account_type_raw"),
        )
        seen[key] = merged

    return list(seen.values())


def detect_cross_account_duplicates(accounts: list[dict]) -> list[str]:
    """Cross-account guardrail for statements that share ONE investor number
    across several registrations (e.g. a T. Rowe Price Roth IRA + Rollover IRA
    under a single investor number, with no per-account number).

    Catches two failure modes that per-account ``validate_extraction`` cannot
    see, because it only reconciles each account against its own total:

      1. The SAME holding copied into more than one account — the extractor
         attributed the whole portfolio to every registration. Signalled by a
         ticker appearing in >1 account with (near-)equal market value.
      2. Account totals that OVERSHOOT the printed statement portfolio total
         (double-counting) — sum(account totals) exceeds the statement-wide
         "Total Portfolio Value" by more than 2%.

    Comparisons are scoped to accounts from the SAME statement, grouped by
    investor_number. Accounts from different statements — a different investor
    number (e.g. a spouse's), or their own account number (e.g. a Schwab
    account in the same household) — are unrelated and never cross-compared,
    so the checks don't fire on a legitimate multi-statement household.

    Every involved account is marked WARNING, the finding appended to its
    ``validation_issues``, and its positions forced to REVIEW (with
    ``original_transfer_eligible`` preserved) — mirroring the value-mismatch
    override. Mutates ``accounts`` in place; returns the finding strings.
    """
    findings: list[str] = []
    if len(accounts) < 2:
        # Duplication across accounts is impossible with a single account, and
        # a lone account is already covered by validate_extraction().
        return findings

    flagged: list[dict] = []
    _flagged_ids: set[int] = set()

    def _flag(acct: dict) -> None:
        if id(acct) not in _flagged_ids:
            _flagged_ids.add(id(acct))
            flagged.append(acct)

    # Group accounts by investor_number so each check only compares accounts
    # that came from the SAME shared-investor statement.
    groups: dict[str, list[dict]] = {}
    for acct in accounts:
        inv = (acct.get("investor_number") or "").strip().upper()
        if inv:
            groups.setdefault(inv, []).append(acct)

    for group in groups.values():
        if len(group) < 2:
            continue

        # ---- 1. Same ticker in >1 account with (near-)equal market value ---
        # Skip cash / blank-symbol / $0 lines: bare cash legitimately shows up
        # in more than one account and carries no ticker.
        sym_hits: dict[str, list[tuple[dict, float]]] = {}
        for acct in group:
            for pos in acct.get("assets", []):
                sym = (pos.get("symbol") or "").strip().upper()
                if not sym:
                    continue
                mv = _safe_float(pos.get("market_value"))
                if mv <= 0:
                    continue
                sym_hits.setdefault(sym, []).append((acct, mv))

        for sym, hits in sorted(sym_hits.items()):
            distinct = {id(a) for a, _ in hits}
            if len(distinct) < 2:
                continue
            mvs = [mv for _, mv in hits]
            hi, lo = max(mvs), min(mvs)
            if hi > 0 and (hi - lo) / hi <= 0.01:
                findings.append(
                    f"Duplicate holding across accounts: {sym} appears in "
                    f"{len(distinct)} accounts at ~${hi:,.2f} each — a holding "
                    f"belongs to exactly one account"
                )
                for a, _ in hits:
                    _flag(a)

        # ---- 2. Account totals vs printed statement portfolio total --------
        grand_total = 0.0
        for acct in group:
            gt = _safe_float(acct.get("statement_portfolio_total"))
            if gt > 0:
                grand_total = gt
                break
        if grand_total > 0:
            totals_sum = sum(_safe_float(a.get("total_value")) for a in group)
            excess = totals_sum - grand_total
            if excess / grand_total > 0.02:
                findings.append(
                    f"Account totals sum to ${totals_sum:,.2f} but the statement "
                    f"portfolio total is ${grand_total:,.2f} (excess ${excess:,.2f}, "
                    f"{excess / grand_total:.1%}) — likely duplicated or "
                    f"double-counted holdings"
                )
                for acct in group:
                    _flag(acct)

    if not findings:
        return findings

    for acct in flagged:
        acct["validation_status"] = "WARNING"
        issues = acct.setdefault("validation_issues", [])
        for f in findings:
            if f not in issues:
                issues.append(f)
        for pos in acct.get("assets", []):
            if pos.get("transfer_eligible") != "REVIEW":
                pos["original_transfer_eligible"] = pos.get("transfer_eligible")
            pos["transfer_eligible"] = "REVIEW"
            pos["transfer_notes"] = (
                "Validation Override: cross-account duplication detected — "
                "positions forced to REVIEW pending manual verification"
            )

    return findings


def consolidate_analyses(analyses: list[dict], client_name: str) -> dict:
    """Merge multiple per-PDF analyses into one consolidated report object."""
    raw_accounts = []

    for a in analyses:
        if "error" in a:
            continue

        acct_assets = a.get("assets", [])
        acct_value = a.get("total_value") or sum(
            (pos.get("market_value") or 0) for pos in acct_assets
        )

        raw_accounts.append({
            "custodian": a.get("custodian"),
            "account_number": a.get("account_number"),
            "investor_number": a.get("investor_number"),
            "account_registration": a.get("account_registration"),
            "statement_portfolio_total": a.get("statement_portfolio_total"),
            "account_type": a.get("account_type"),
            "account_type_raw": a.get("account_type_raw"),
            "account_holder": a.get("account_holder"),
            "statement_date": a.get("statement_date"),
            "statement_age_days": a.get("statement_age_days"),
            "is_stale": a.get("is_stale", False),
            "cash_balance": a.get("cash_balance"),
            "total_value": acct_value,
            "is_rollover": a.get("is_rollover", False),
            "rollover_note": a.get("rollover_note"),
            "is_inherited": a.get("is_inherited", False),
            "inherited_note": a.get("inherited_note"),
            "assets": acct_assets,
            "custodian_intel": a.get("custodian_intel"),
            "apex_restriction": a.get("apex_restriction"),
            "apex_special_handling": a.get("apex_special_handling"),
            "validation_status": a.get("validation_status", "VALID"),
            "validation_issues": a.get("validation_issues", []),
        })

    accounts = _dedup_accounts(raw_accounts)
    if len(accounts) < len(raw_accounts):
        log.info("  Deduplication removed %d duplicate account(s)", len(raw_accounts) - len(accounts))

    # Cross-account guardrail (e.g. T. Rowe Price shared investor number):
    # catch the same holding copied into multiple registrations, or account
    # totals that overshoot the printed statement portfolio total. Involved
    # accounts are marked WARNING and their positions forced to REVIEW.
    dup_findings = detect_cross_account_duplicates(accounts)
    for finding in dup_findings:
        log.warning("    ⚠ Cross-account: %s", finding)

    total_value = 0.0
    total_transfer_value = 0.0
    acat_count = 0
    liquidate_count = 0
    unsupported_count = 0
    transfer_count = 0
    review_count = 0

    for acct in accounts:
        total_value += acct.get("total_value") or 0
        for pos in acct.get("assets", []):
            te = (pos.get("transfer_eligible") or "").upper()
            if te == "ACAT":
                acat_count += 1
                total_transfer_value += pos.get("market_value") or 0
            elif te == "LIQUIDATE":
                liquidate_count += 1
            elif te == "UNSUPPORTED":
                unsupported_count += 1
            elif te == "ACH/WIRE":
                transfer_count += 1
            else:
                review_count += 1

    total_positions = acat_count + liquidate_count + unsupported_count + transfer_count + review_count

    log.info(
        "  Consolidation: %d accounts, %d positions, $%s total | "
        "ACAT=%d, LIQUIDATE=%d, UNSUPPORTED=%d, ACH/WIRE=%d, REVIEW=%d",
        len(accounts), total_positions, f"{total_value:,.2f}",
        acat_count, liquidate_count, unsupported_count, transfer_count, review_count,
    )

    return {
        "client_name": client_name,
        "processed_at": datetime.now(ET).isoformat(),
        "total_accounts": len(accounts),
        "total_positions": total_positions,
        "total_value": total_value,
        "acat_count": acat_count,
        "liquidate_count": liquidate_count,
        "unsupported_count": unsupported_count,
        "transfer_count": transfer_count,
        "review_count": review_count,
        "total_transfer_value": total_transfer_value,
        "accounts": accounts,
    }


# ---------------------------------------------------------------------------
# Orchestrator – process one client folder
# ---------------------------------------------------------------------------
def _classify_account(
    result: dict,
    notion_db: NotionRestrictionDB,
    ticker_db: Optional["NotionTickerDB"],
    apex_rules_db: Optional["NotionApexRulesDB"],
    custodian_db: Optional[NotionCustodianDB],
) -> dict:
    """
    Run the full deterministic classification pipeline on a single account
    extracted by Gemini. Mutates and returns the account dict.
    """
    # 1. Normalize account type
    raw_type = result.pop("account_type_raw", result.get("account_type", ""))
    account_type, is_rollover = normalize_account_type(raw_type)
    result["account_type"] = account_type
    result["account_type_raw"] = raw_type
    result["is_rollover"] = is_rollover
    if is_rollover:
        result["rollover_note"] = (
            "Rollover account — all assets will be liquidated at the "
            "sending custodian and transferred as cash to the receiving account."
        )
    if account_type in _INHERITED_TYPES:
        result["is_inherited"] = True
        result["inherited_note"] = (
            f"{account_type} — cannot be automatically transferred due to "
            "differing titling between institutions. Requires manual paperwork "
            "and processing to ensure exact titling match."
        )
    if account_type == "Employee Stock Plan":
        result["is_employee_stock_plan"] = True
        result["employee_stock_plan_note"] = (
            "Employee Stock Plan / RSU account — unvested or restricted "
            "holdings cannot be transferred via ACAT. Vested shares may "
            "force a partial ACAT and typically require manual paperwork "
            "at the sending custodian."
        )
    log.info("    Account type: '%s' → %s%s%s%s", raw_type, account_type,
             " (rollover)" if is_rollover else "",
             " (inherited)" if account_type in _INHERITED_TYPES else "",
             " (stock plan)" if account_type == "Employee Stock Plan" else "")

    # 1.5. Resolve CUSIP-like symbols via the Mutual Fund Restriction DB.
    #       Statements sometimes print CUSIPs instead of tickers; without
    #       this step a bond mutual fund's CUSIP triggers the Fixed Income
    #       heuristic and the fund is incorrectly routed to LIQUIDATE.
    _cusip_re = re.compile(r"^[A-Z0-9]{9}$")
    cusip_positions = [
        p for p in result.get("assets", [])
        if p.get("symbol")
        and _cusip_re.match(p["symbol"].upper().strip())
        and not p["symbol"].upper().strip().isalpha()
    ]
    if cusip_positions:
        cusip_values = [p["symbol"].upper().strip() for p in cusip_positions]
        resolved = notion_db.query_cusips(cusip_values)
        for pos in cusip_positions:
            cusip = pos["symbol"].upper().strip()
            ticker = resolved.get(cusip)
            if ticker:
                log.info("    CUSIP %s → ticker %s (resolved via Mutual Fund DB)", cusip, ticker)
                pos["original_symbol"] = cusip
                pos["symbol"] = ticker

    # 2. Classify asset types via ticker DB + heuristics.
    #    Expand comma-separated multi-ticker symbol fields (robo-advisor
    #    asset-class rows like "VTI, SCHB, VTV") so each constituent is queried
    #    individually against the Stock Tickers DB — otherwise the combined
    #    string misses the DB and classify_asset_type's multi-ticker path can
    #    only fall back to heuristics.
    all_symbols = []
    for p in result.get("assets", []):
        sym = p.get("symbol")
        if sym:
            all_symbols.extend(t.strip() for t in sym.split(",") if t.strip())
    if ticker_db and all_symbols:
        ticker_db.query_symbols(all_symbols)

    for pos in result.get("assets", []):
        pos["type"], pos["classification_source"] = classify_asset_type(pos, ticker_db)

    # 3. Notion check for mutual fund symbols
    mf_symbols = [
        p["symbol"] for p in result.get("assets", [])
        if p.get("type") == "Mutual Fund" and p.get("symbol")
    ]
    if mf_symbols:
        notion_db.query_symbols(mf_symbols)

    # 4. Apex account-level rule
    #    Check the raw statement string first (e.g. "Stock Plan",
    #    "Employee Stock Plan") so Ops-authored Notion keywords can match
    #    custodian wording that our canonical map hasn't been taught yet.
    #    Fall back to the canonical type.
    apex_acct_rule = None
    if apex_rules_db and apex_rules_db.rules:
        if raw_type:
            apex_acct_rule = apex_rules_db.lookup_account(raw_type)
        if apex_acct_rule is None:
            apex_acct_rule = apex_rules_db.lookup_account(account_type)
    if apex_acct_rule and apex_acct_rule.get("rule_type") == "UNSUPPORTED":
        result["apex_restriction"] = (
            apex_acct_rule.get("notes") or f"Account type not supported: {account_type}"
        )

    # 5. Classify transfer eligibility for each position
    for pos in result.get("assets", []):
        asset_type = (pos.get("type") or "Other").strip()

        apex_asset_rule = None
        if apex_rules_db and apex_rules_db.rules:
            apex_asset_rule = apex_rules_db.lookup_asset(asset_type)

        notion_check = None
        if asset_type == "Mutual Fund" and pos.get("symbol"):
            notion_check = notion_db.check_symbol(pos["symbol"])
            pos["notion_check"] = notion_check

        pos["transfer_eligible"], pos["transfer_notes"] = classify_transfer_eligibility(
            asset=pos,
            account_type=account_type,
            is_rollover=is_rollover,
            notion_check=notion_check,
            apex_acct_rule=apex_acct_rule,
            apex_asset_rule=apex_asset_rule,
        )

    # 6. Custodian enrichment
    enrich_with_custodian_data(result, custodian_db)

    return result


class DriveSource:
    """Where process_client_folder reads a client's documents: the client's subfolder of the Drive input folder,
    archiving each document to the client's subfolder of the processed folder. The demo passes its own source
    with the same four methods (stand_ins.SampleStatementSource)."""

    # Seconds between documents, for the model's rate limit.
    throttle_seconds = 2

    def __init__(self, drive, processed_folder_id: str):
        self.drive = drive
        self.processed_folder_id = processed_folder_id
        self._archive_folder_id: Optional[str] = None

    def prepare(self, folder: dict) -> None:
        self._archive_folder_id = get_or_create_subfolder(self.drive, self.processed_folder_id, folder["name"])

    def list_documents(self, folder: dict) -> list[dict]:
        return list_documents_in_folder(self.drive, folder["id"])

    def download(self, doc_meta: dict, dest_path: str) -> None:
        download_file(self.drive, doc_meta["id"], dest_path)

    def archive(self, doc_meta: dict) -> None:
        move_file_to_folder(self.drive, doc_meta["id"], self._archive_folder_id)


def process_client_folder(
    drive,
    folder: dict,
    notion_db: NotionRestrictionDB,
    custodian_db: Optional[NotionCustodianDB],
    apex_rules_db: Optional["NotionApexRulesDB"],
    ticker_db: Optional["NotionTickerDB"],
    db_conn,
    processed_folder_id: str,
    gemini_model: str = "gemini-3.5-flash",
    source=None,
) -> Optional[str]:
    """
    Process all documents (PDF, PNG, JPEG) in a client subfolder.
    Returns the household UUID from Postgres, or None on failure.
    Documents come from Drive unless another *source* is given.
    """
    client_name = folder["name"]
    folder_id = folder["id"]
    log.info("━" * 60)
    log.info("Processing client: %s", client_name)

    source = source or DriveSource(drive, processed_folder_id)
    source.prepare(folder)

    docs = source.list_documents(folder)
    if not docs:
        log.info("  No documents found — skipping.")
        return None

    # Deduplicate documents within the same run by filename
    seen_filenames: set[str] = set()
    unique_docs = []
    for doc_meta in docs:
        if doc_meta["name"] not in seen_filenames:
            seen_filenames.add(doc_meta["name"])
            unique_docs.append(doc_meta)
        else:
            log.info("  Skipping duplicate document: %s", doc_meta["name"])
    docs = unique_docs

    docs_total = len(docs)
    log.info("  Found %d document(s)", docs_total)
    analyses = []
    doc_results: list[dict] = []
    docs_extracted = 0

    for doc_idx, doc_meta in enumerate(docs):
        fname = doc_meta["name"]
        mime_type = doc_meta.get("mimeType", "application/pdf")
        suffix = SUPPORTED_MIME_TYPES.get(mime_type, ".pdf")

        if doc_idx > 0 and source.throttle_seconds:
            time.sleep(source.throttle_seconds)

        log.info("  Analyzing (%d/%d): %s", doc_idx + 1, docs_total, fname)

        doc_record = {
            "filename": fname,
            "mime_type": mime_type,
            "doc_type": None,
            "status": "pending",
            "reason": None,
            "accounts_extracted": 0,
            "positions_extracted": 0,
        }

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name

        try:
            source.download(doc_meta, tmp_path)

            # Pre-extraction classification (skipped entirely when bypass is on)
            if doc_classification_bypassed():
                doc_record["doc_type"] = "classification_bypassed"
                log.info("    ⚙ Doc classification BYPASSED (BYPASS_DOC_CLASSIFICATION) — extracting %s", fname)
            else:
                classification = classify_document_with_gemini(tmp_path, mime_type, gemini_model)
                doc_type = classification.get("doc_type", "unknown")
                confidence = classification.get("confidence", "unknown")
                doc_record["doc_type"] = doc_type
                log.info("    Classification: %s (confidence: %s)", doc_type, confidence)

                decision, reason = evaluate_doc_gate(doc_type, bypass=False)
                if decision == "reject":
                    doc_record["status"] = "rejected"
                    doc_record["reason"] = reason
                    log.info("    ✗ Rejected: %s (%s)", fname, doc_type)
                    doc_results.append(doc_record)
                    try:
                        source.archive(doc_meta)
                    except Exception as exc:
                        log.warning("    Could not archive %s: %s", fname, exc)
                    continue

                if doc_type not in _ALLOWED_DOC_TYPES:
                    log.info("    ⚠ Classification unclear (%s) — attempting extraction anyway", doc_type)

            # Full extraction
            results = analyze_document_with_gemini(tmp_path, mime_type, gemini_model)
            accts_from_doc = 0
            pos_from_doc = 0

            for result in results:
                if "error" not in result:
                    _reconcile_cash(result)

                    _classify_account(
                        result, notion_db, ticker_db, apex_rules_db, custodian_db,
                    )

                    v_status, v_issues = validate_extraction(result)
                    result["validation_status"] = v_status
                    result["validation_issues"] = v_issues

                    # Statement freshness — flag (never drop). Sets
                    # statement_age_days + is_stale; surfaced as its own UI badge.
                    age = flag_statement_freshness(result)
                    if result.get("is_stale"):
                        log.info("    ⏳ Stale statement: %s is %d days old (flagged, still processed)", fname, age)

                    # Cost basis check — tags lot/position granularity per
                    # position and flags coverage on taxable accounts. Purely
                    # informational; does not affect transfer eligibility.
                    cb_status, cb_issues = validate_cost_basis(result)
                    result["cost_basis_status"] = cb_status
                    result["cost_basis_issues"] = cb_issues
                    # Always log a one-line cost-basis summary per account so the
                    # feature is observable in Cloud Run logs (grep "Cost basis:").
                    if cb_status == "NOT_APPLICABLE":
                        log.info(
                            "    Cost basis: not applicable (%s)",
                            result.get("account_type") or "non-taxable",
                        )
                    else:
                        _cb_secs = [p for p in result.get("assets", []) if not _is_cash_line_item(p)]
                        _cb_with = sum(1 for p in _cb_secs if _position_has_basis(p))
                        _cb_lot = sum(1 for p in _cb_secs if p.get("cost_basis_granularity") == "lot")
                        _cb_pos = sum(1 for p in _cb_secs if p.get("cost_basis_granularity") == "position")
                        log.info(
                            "    Cost basis: %s — %d/%d securities have basis "
                            "(%d lot-level, %d position-level)%s",
                            cb_status, _cb_with, len(_cb_secs), _cb_lot, _cb_pos,
                            (" | " + "; ".join(cb_issues)) if cb_issues else "",
                        )

                    if v_status == "WARNING" and any("Value mismatch" in i for i in v_issues):
                        for pos in result.get("assets", []):
                            pos["original_transfer_eligible"] = pos.get("transfer_eligible")
                            pos["transfer_eligible"] = "REVIEW"
                            pos["transfer_notes"] = (
                                f"Validation Override: {v_issues[0]} — "
                                "all positions forced to REVIEW pending manual verification"
                            )

                    analyses.append(result)
                    accts_from_doc += 1
                    pos_from_doc += len(result.get("assets", []))
                    log.info(
                        "    ✓ Classified %d positions from %s (%s)%s",
                        len(result.get("assets", [])),
                        result.get("custodian", "Unknown"),
                        result.get("account_type", "Unknown"),
                        f" [VALIDATION: {v_status}]" if v_status != "VALID" else "",
                    )
                else:
                    log.warning("    ✗ Gemini extraction failed for %s", fname)
                    analyses.append(result)

            doc_record["status"] = "extracted"
            doc_record["accounts_extracted"] = accts_from_doc
            doc_record["positions_extracted"] = pos_from_doc
            docs_extracted += 1
        finally:
            os.unlink(tmp_path)

        doc_results.append(doc_record)

        # Archive to processed folder
        try:
            source.archive(doc_meta)
            log.info("    → Archived to processed folder")
        except Exception as exc:
            log.warning("    Could not archive %s: %s", fname, exc)

    # Consolidate all analyses for this client
    consolidated = consolidate_analyses(analyses, client_name)
    consolidated["docs_total"] = docs_total
    consolidated["docs_extracted"] = docs_extracted
    consolidated["doc_results"] = doc_results

    if consolidated["total_accounts"] == 0:
        log.warning("  No valid analyses — skipping.")
        return None

    # Determine run number (count of previous runs for same source folder + 1)
    run_number = pipeline_db.count_runs_for_folder(db_conn, folder_id) + 1
    consolidated["run_number"] = run_number

    # Write to Postgres
    household_id = pipeline_db.write_household(db_conn, consolidated, folder_id)
    log.info("  Household saved to Postgres: %s (run #%d)", household_id, run_number)

    # Mark previous runs for this folder as superseded
    superseded = pipeline_db.supersede_previous_runs(db_conn, folder_id, household_id)
    if superseded:
        log.info("  Superseded %d previous run(s)", superseded)

    # Auto-seed destination accounts (Accounts to be opened at Apex). Idempotent —
    # preserves any Ops mapping edits across re-runs.
    try:
        seeded = _seed_destination_accounts(db_conn, folder_id, consolidated.get("accounts", []))
        if seeded:
            log.info("  Seeded %d destination account(s) to be opened", seeded)
    except Exception as exc:
        log.warning("  Destination auto-seed skipped: %s", exc)

    return household_id


# ---------------------------------------------------------------------------
# Slack webhook integration (optional, env-var-gated)
# ---------------------------------------------------------------------------

def _scan_summary_blocks(results: list[dict]) -> list[dict]:
    """The Slack blocks summarizing one scan."""
    successes = [r for r in results if r.get("status") == "success"]
    failures = [r for r in results if r.get("status") == "error"]

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "Statement Pipeline — Scan Complete"},
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*{len(results)}* client(s) processed  |  "
                    f"*{len(successes)}* succeeded  |  "
                    f"*{len(failures)}* failed"
                ),
            },
        },
    ]

    if successes:
        client_list = "\n".join(
            f"• {r['client']} (`{r.get('household_id', 'N/A')}`)" for r in successes
        )
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Processed:*\n{client_list}"},
        })

    if failures:
        fail_list = "\n".join(
            f"• {r['client']}: `{r.get('error', 'unknown')[:100]}`" for r in failures
        )
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Failures:*\n{fail_list}"},
        })
    return blocks


def _record_scan_summary_in_outbox(blocks: list[dict]) -> None:
    """Demo mode: keep the scan summary in the Outbox, as the text Slack would have shown."""
    title = blocks[0]["text"]["text"]
    body = "\n\n".join(b["text"]["text"] for b in blocks[1:])
    conn = pipeline_db.get_connection()
    try:
        pipeline_db.insert_outbox_entry(
            conn, kind="slack", title=title, body=body,
            meta={"channel": "Slack scan summary", "blocks": blocks}, created_by=None, keep=demo.MAX_OUTBOX,
        )
    finally:
        pipeline_db.put_connection(conn)
    log.info("Scan summary captured in the Outbox")


def send_slack_notification(results: list[dict]) -> None:
    """Post a summary to Slack if SLACK_WEBHOOK_URL is configured. In demo
    mode it is captured in the Outbox instead, and nothing is posted."""
    if demo.demo_mode():
        try:
            _record_scan_summary_in_outbox(_scan_summary_blocks(results))
        except Exception as exc:
            log.warning("Outbox capture of the scan summary failed: %s", exc)
        return

    webhook_url = os.getenv("SLACK_WEBHOOK_URL")
    if not webhook_url:
        return
    blocks = _scan_summary_blocks(results)

    try:
        resp = requests.post(webhook_url, json={"blocks": blocks}, timeout=10)
        if resp.ok:
            log.info("Slack notification sent")
        else:
            log.warning("Slack webhook returned %s: %s", resp.status_code, resp.text[:200])
    except Exception as exc:
        log.warning("Slack notification failed: %s", exc)


# ---------------------------------------------------------------------------
# Single-pass scan (for Cloud Run / Cloud Scheduler triggers)
# ---------------------------------------------------------------------------
def _init_databases(notion_token_key, notion_database_id, notion_custodian_db_id,
                     notion_apex_rules_db_id, notion_ticker_db_id):
    """Initialize all Notion databases. Returns (notion_db, custodian_db, apex_rules_db, ticker_db)."""
    notion_db = NotionRestrictionDB(notion_token_key, notion_database_id)
    log.info("Notion restriction DB ready (on-demand query mode)")

    custodian_db = None
    if notion_custodian_db_id:
        custodian_db = NotionCustodianDB(notion_token_key, notion_custodian_db_id)
    else:
        log.info("Custodian DB not configured — skipping enrichment.")

    apex_rules_db = None
    if notion_apex_rules_db_id:
        try:
            apex_rules_db = NotionApexRulesDB(notion_token_key, notion_apex_rules_db_id)
        except Exception as exc:
            log.warning("Could not load Apex Rules DB (%s) — skipping.", exc)
    else:
        log.info("Apex Rules DB not configured.")

    ticker_db = None
    if notion_ticker_db_id:
        ticker_db = NotionTickerDB(notion_token_key, notion_ticker_db_id)
        log.info("Ticker DB ready (on-demand query mode)")
    else:
        log.info("Ticker DB not configured — using heuristic classification only.")

    return notion_db, custodian_db, apex_rules_db, ticker_db


def run_once(
    credentials_path: str,
    input_folder_id: str,
    processed_folder_id: str,
    gcp_project_id: str,
    gcp_location: str,
    notion_token_key: str,
    notion_database_id: str,
    notion_custodian_db_id: str = None,
    notion_apex_rules_db_id: str = None,
    notion_ticker_db_id: str = None,
    gemini_model: str = "gemini-3.5-flash",
) -> list[dict]:
    """
    Run a single scan of the input folder. Returns a list of results.

    Use this for Cloud Run / Cloud Scheduler instead of the polling loop.
    Each invocation scans once and exits.
    """
    log.info("Statement Pipeline v2 — single-pass scan")

    drive = build_google_services(credentials_path)
    _init_genai(project=gcp_project_id, location=gcp_location, model=gemini_model)

    notion_db, custodian_db, apex_rules_db, ticker_db = _init_databases(
        notion_token_key, notion_database_id, notion_custodian_db_id,
        notion_apex_rules_db_id, notion_ticker_db_id,
    )

    db_conn = pipeline_db.get_connection()
    try:
        pipeline_db.ensure_schema(db_conn)

        results = []
        subfolders = list_subfolders(drive, input_folder_id)

        if not subfolders:
            log.info("No client folders found.")
            return results

        for folder in subfolders:
            docs = list_documents_in_folder(drive, folder["id"])
            if docs:
                mime_counts = {}
                for d in docs:
                    mt = d.get("mimeType", "unknown")
                    mime_counts[mt] = mime_counts.get(mt, 0) + 1
                log.info("Client '%s': %d doc(s) — %s", folder["name"], len(docs),
                         ", ".join(f"{v} {k.split('/')[-1]}" for k, v in mime_counts.items()))
                try:
                    household_id = process_client_folder(
                        drive=drive,
                        folder=folder,
                        notion_db=notion_db,
                        custodian_db=custodian_db,
                        apex_rules_db=apex_rules_db,
                        ticker_db=ticker_db,
                        db_conn=db_conn,
                        processed_folder_id=processed_folder_id,
                        gemini_model=gemini_model,
                    )
                    if household_id:
                        results.append({
                            "client": folder["name"],
                            "status": "success",
                            "household_id": household_id,
                        })
                    else:
                        results.append({
                            "client": folder["name"],
                            "status": "skipped",
                            "reason": "No extractable documents found",
                        })
                except Exception as exc:
                    log.exception("Error processing %s: %s", folder["name"], exc)
                    results.append({
                        "client": folder["name"],
                        "status": "error",
                        "error": str(exc),
                    })
    finally:
        pipeline_db.put_connection(db_conn)

    log.info("Scan complete — %d client(s) processed", len(results))

    if results:
        send_slack_notification(results)

    return results


# ---------------------------------------------------------------------------
# Main polling loop (for local development)
# ---------------------------------------------------------------------------
def run_pipeline(
    credentials_path: str,
    input_folder_id: str,
    processed_folder_id: str,
    gcp_project_id: str,
    gcp_location: str,
    notion_token_key: str,
    notion_database_id: str,
    notion_custodian_db_id: str = None,
    notion_apex_rules_db_id: str = None,
    notion_ticker_db_id: str = None,
    poll_interval: int = 30,
    gemini_model: str = "gemini-3.5-flash",
):
    """Entry point — polls Drive and processes new client folders."""
    log.info("=" * 60)
    log.info("ACAT Statement Automation Pipeline v2")
    log.info("=" * 60)

    drive = build_google_services(credentials_path)
    log.info("Google Drive authenticated")

    _init_genai(project=gcp_project_id, location=gcp_location, model=gemini_model)
    log.info("Vertex AI: project=%s, location=%s, model=%s",
             gcp_project_id, gcp_location, gemini_model)

    notion_db, custodian_db, apex_rules_db, ticker_db = _init_databases(
        notion_token_key, notion_database_id, notion_custodian_db_id,
        notion_apex_rules_db_id, notion_ticker_db_id,
    )

    db_conn = pipeline_db.get_connection()
    pipeline_db.ensure_schema(db_conn)
    log.info("Postgres connected and schema verified")

    log.info("Entering polling loop (every %ds)...", poll_interval)
    log.info("-" * 60)

    while True:
        try:
            # Health-check the connection; reconnect if stale
            try:
                with db_conn.cursor() as cur:
                    cur.execute("SELECT 1")
            except (psycopg2.OperationalError, psycopg2.InterfaceError):
                log.warning("DB connection lost — reconnecting")
                try:
                    db_conn.close()
                except Exception:
                    pass
                db_conn = pipeline_db.get_connection()

            subfolders = list_subfolders(drive, input_folder_id)

            if not subfolders:
                log.debug("No client folders found — sleeping.")
            else:
                for folder in subfolders:
                    docs = list_documents_in_folder(drive, folder["id"])
                    if docs:
                        process_client_folder(
                            drive=drive,
                            folder=folder,
                            notion_db=notion_db,
                            custodian_db=custodian_db,
                            apex_rules_db=apex_rules_db,
                            ticker_db=ticker_db,
                            db_conn=db_conn,
                            processed_folder_id=processed_folder_id,
                            gemini_model=gemini_model,
                        )
        except KeyboardInterrupt:
            log.info("Pipeline stopped by user.")
            break
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as exc:
            log.warning("DB error in polling loop — will reconnect next iteration: %s", exc)
            try:
                db_conn.close()
            except Exception:
                pass
            db_conn = pipeline_db.get_connection()
        except Exception as exc:
            log.exception("Unhandled error in polling loop: %s", exc)

        time.sleep(poll_interval)

    db_conn.close()


# ---------------------------------------------------------------------------
# __main__
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()

    run_pipeline(
        credentials_path=os.getenv("GOOGLE_CREDENTIALS_PATH", "credentials.json"),
        input_folder_id=os.getenv("INPUT_FOLDER_ID"),
        processed_folder_id=os.getenv("PROCESSED_FOLDER_ID"),
        gcp_project_id=os.getenv("GCP_PROJECT_ID"),
        gcp_location=os.getenv("GCP_LOCATION", "us-central1"),
        notion_token_key=os.getenv("NOTION_TOKEN_KEY"),
        notion_database_id=os.getenv("NOTION_DATABASE_ID"),
        notion_custodian_db_id=os.getenv("NOTION_CUSTODIAN_DB_ID"),
        notion_apex_rules_db_id=os.getenv("NOTION_APEX_RULES_DB_ID"),
        notion_ticker_db_id=os.getenv("NOTION_TICKER_DB_ID"),
        poll_interval=int(os.getenv("POLL_INTERVAL", "30")),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.5-flash"),
    )
