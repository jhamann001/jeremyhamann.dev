"""
Statement Pipeline — PDF Report Generator
=====================================
Generates PDF reports for individual households or all households combined.

Uses fpdf2 for lightweight, zero-system-dependency PDF generation.
The built-in Helvetica font only supports Latin-1, so all text is sanitized
before rendering via _safe() to replace common Unicode characters.
"""

from datetime import datetime
from io import BytesIO
from zoneinfo import ZoneInfo

from fpdf import FPDF

ET = ZoneInfo("America/New_York")

# ---------------------------------------------------------------------------
# Color palette (RGB tuples)
# ---------------------------------------------------------------------------
_BLACK = (10, 10, 10)
_WHITE = (255, 255, 255)
_SLATE_50 = (248, 250, 252)
_SLATE_200 = (226, 232, 240)
_SLATE_500 = (100, 116, 139)
_SLATE_700 = (51, 65, 85)
_SLATE_900 = (15, 23, 42)
_GREEN_700 = (21, 128, 61)
_YELLOW_700 = (161, 98, 7)
_ORANGE_700 = (194, 65, 12)
_RED_700 = (185, 28, 28)
_BLUE_700 = (29, 78, 216)
_PURPLE_700 = (126, 34, 206)

_STATUS_COLORS = {
    "ACAT": _GREEN_700,
    "LIQUIDATE": _ORANGE_700,
    "UNSUPPORTED": _SLATE_900,
    "REVIEW": _YELLOW_700,
    "ACH/WIRE": _BLUE_700,
}

_UNICODE_REPLACEMENTS = {
    "\u2022": "*",   # bullet
    "\u2026": "...", # ellipsis
    "\u2014": "--",  # em dash
    "\u2013": "-",   # en dash
    "\u2018": "'",   # left single quote
    "\u2019": "'",   # right single quote
    "\u201c": '"',   # left double quote
    "\u201d": '"',   # right double quote
}


def _safe(text) -> str:
    """Sanitize text for Latin-1 compatible PDF output."""
    if text is None:
        return ""
    s = str(text)
    for orig, repl in _UNICODE_REPLACEMENTS.items():
        s = s.replace(orig, repl)
    return s.encode("latin-1", errors="replace").decode("latin-1")


def _fmt_currency(val) -> str:
    if val is None:
        return "-"
    try:
        n = float(val)
    except (ValueError, TypeError):
        return "-"
    return f"${n:,.2f}"


def _fmt_number(val) -> str:
    if val is None:
        return "-"
    try:
        n = float(val)
    except (ValueError, TypeError):
        return "-"
    if n == int(n):
        return f"{int(n):,}"
    return f"{n:,.4f}"


def _fmt_date(iso_str: str) -> str:
    if not iso_str:
        return "-"
    try:
        dt = datetime.fromisoformat(iso_str)
        return dt.strftime("%B %d, %Y at %I:%M %p")
    except (ValueError, TypeError):
        return _safe(iso_str)


def _trunc(text: str, max_len: int = 50) -> str:
    if not text:
        return ""
    s = _safe(text)
    return s[:max_len] + "..." if len(s) > max_len else s


# ---------------------------------------------------------------------------
# PDF builder
# ---------------------------------------------------------------------------

class HouseholdPDF(FPDF):
    """Custom FPDF subclass with header/footer branding."""

    def __init__(self, client_name: str):
        super().__init__(orientation="L", format="letter")
        self.client_name = client_name
        self.set_auto_page_break(auto=True, margin=20)

    def header(self):
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(*_SLATE_500)
        self.cell(0, 6, "CEDAR RIDGE WEALTH", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*_SLATE_200)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "", 7)
        self.set_text_color(*_SLATE_500)
        self.cell(0, 8, f"Confidential -- {_safe(self.client_name)}", align="L")
        self.cell(0, 8, f"Page {self.page_no()}/{{nb}}", align="R")

    # -- Layout helpers --

    def section_title(self, text: str):
        self.set_font("Helvetica", "B", 13)
        self.set_text_color(*_SLATE_900)
        self.cell(0, 10, _safe(text), new_x="LMARGIN", new_y="NEXT")
        self.ln(2)

    def subsection_title(self, text: str):
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(*_SLATE_700)
        self.cell(0, 8, _safe(text), new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def kv_line(self, label: str, value: str):
        label_w = 55
        value_w = self.w - self.l_margin - self.r_margin - label_w
        x_start = self.l_margin
        y_start = self.get_y()

        self.set_font("Helvetica", "B", 9)
        self.set_text_color(*_SLATE_500)
        self.set_xy(x_start, y_start)
        self.cell(label_w, 6, label)

        self.set_font("Helvetica", "", 9)
        self.set_text_color(*_SLATE_900)
        self.set_xy(x_start + label_w, y_start)
        self.multi_cell(value_w, 6, _safe(value) if value else "-", new_x="LMARGIN", new_y="NEXT")

    def info_box(self, text: str, color: tuple = _SLATE_700):
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(*color)
        indent = 3
        x_start = self.l_margin
        y_start = self.get_y()
        body_w = self.w - self.l_margin - self.r_margin - indent

        self.set_xy(x_start, y_start)
        self.cell(indent, 5, "-")
        self.set_xy(x_start + indent, y_start)
        self.multi_cell(body_w, 5, _safe(text), new_x="LMARGIN", new_y="NEXT")
        self.set_text_color(*_BLACK)
        self.ln(1)


def generate_household_pdf(household: dict) -> bytes:
    """
    Generate a comprehensive PDF report for a single household.
    Returns the PDF content as bytes.
    """
    client_name = household.get("client_name", "Unknown Client")
    pdf = HouseholdPDF(_safe(client_name))
    pdf.alias_nb_pages()
    pdf.add_page()

    _render_household_section(pdf, household)
    _add_disclaimer(pdf)

    buf = BytesIO()
    pdf.output(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# All-households combined PDF
# ---------------------------------------------------------------------------

def generate_all_households_pdf(households: list[dict]) -> bytes:
    """
    Generate a single PDF containing all households, separated by page breaks.
    Each household gets the same detailed treatment as the single-household report.
    """
    pdf = HouseholdPDF("All Clients")
    pdf.alias_nb_pages()

    for idx, household in enumerate(households):
        if idx > 0:
            pdf.add_page()

        _render_household_section(pdf, household)

    _add_disclaimer(pdf)

    buf = BytesIO()
    pdf.output(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Shared rendering logic
# ---------------------------------------------------------------------------

def _render_household_section(pdf: HouseholdPDF, household: dict):
    """Render a full household section into the PDF (used by both single and combined)."""
    client_name = household.get("client_name", "Unknown Client")

    if pdf.page == 0:
        pdf.add_page()

    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(*_SLATE_900)
    pdf.cell(0, 12, _safe(client_name), new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(*_SLATE_500)
    pdf.cell(0, 7, "ACAT Transfer Analysis Report", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(6)

    accounts = household.get("accounts", [])
    total_value = sum(float(a.get("total_value") or 0) for a in accounts)
    total_positions = sum(len(a.get("assets", [])) for a in accounts)

    status_counts = {"ACAT": 0, "LIQUIDATE": 0, "UNSUPPORTED": 0, "REVIEW": 0, "ACH/WIRE": 0}
    for acc in accounts:
        for pos in acc.get("assets", []):
            s = pos.get("effective_status") or pos.get("transfer_eligible") or ""
            if s in status_counts:
                status_counts[s] += 1

    pdf.section_title("Household Summary")
    pdf.kv_line("Total Household Value:", _fmt_currency(total_value))
    pdf.kv_line("Total Accounts:", str(len(accounts)))
    pdf.kv_line("Total Positions:", str(total_positions))
    pdf.kv_line("Processed:", _fmt_date(household.get("processed_at")))
    pdf.kv_line("Run Number:", str(household.get("run_number", 1)))
    pdf.kv_line("Documents:", f"{household.get('docs_extracted', 0)} extracted / {household.get('docs_total', 0)} total")
    pdf.ln(2)

    pdf.subsection_title("Transfer Status Breakdown")
    for status, count in status_counts.items():
        color = _STATUS_COLORS.get(status, _SLATE_700)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*color)
        pdf.cell(30, 6, status)
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(*_SLATE_900)
        pct = f"({count / total_positions * 100:.0f}%)" if total_positions else ""
        pdf.cell(0, 6, f"{count} positions {pct}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    doc_results = household.get("doc_results", [])
    if doc_results:
        pdf.section_title("Document Ingestion")
        doc_fixed = 100 + 30 + 55
        col_widths = [100, 30, 55, _remaining_width(pdf, doc_fixed)]
        _table_header(pdf, ["Filename", "Status", "Extracted", "Notes"], col_widths)
        for doc in doc_results:
            extracted = ""
            if doc.get("status") == "extracted":
                extracted = f"{doc.get('accounts_extracted', 0)} accts, {doc.get('positions_extracted', 0)} pos"
            _table_row(pdf, [
                doc.get("filename", ""),
                (doc.get("status", "") or "").upper(),
                extracted,
                doc.get("reason", "") or "",
            ], col_widths)
        pdf.ln(6)

    for i, acc in enumerate(accounts):
        _check_page_space(pdf, 60)
        custodian = acc.get("custodian", "Unknown")
        acct_type = acc.get("account_type", "")
        acct_num = acc.get("account_number", "")
        holder = acc.get("account_holder", "")

        pdf.section_title(f"Account {i + 1}: {_safe(custodian)} -- {_safe(acct_type)}")
        pdf.kv_line("Account Number:", _safe(acct_num))
        if holder:
            pdf.kv_line("Account Holder:", _safe(holder))
        pdf.kv_line("Statement Date:", acc.get("statement_date") or "-")
        pdf.kv_line("Account Value:", _fmt_currency(acc.get("total_value")))
        if acc.get("cash_balance") is not None:
            pdf.kv_line("Cash Balance:", _fmt_currency(acc.get("cash_balance")))

        if acc.get("is_rollover"):
            pdf.ln(2)
            pdf.info_box(
                f"ROLLOVER ACCOUNT: {acc.get('rollover_note') or 'All assets will be liquidated and transferred as cash.'}",
                _PURPLE_700,
            )
        if acc.get("is_inherited"):
            pdf.info_box(
                f"INHERITED / BENEFICIARY ACCOUNT: {acc.get('inherited_note') or 'Requires manual review due to potential titling issues.'}",
                _YELLOW_700,
            )
        if acc.get("apex_restriction"):
            pdf.info_box(
                f"APEX HARD-BLOCK: {acc.get('apex_restriction')}",
                _RED_700,
            )

        intel = acc.get("custodian_intel")
        if intel and isinstance(intel, dict):
            pdf.ln(1)
            pdf.subsection_title("Custodian Intelligence")
            if intel.get("dtcc_number"):
                pdf.kv_line("DTCC Number:", intel["dtcc_number"])
            if intel.get("acat_timeline"):
                pdf.kv_line("ACAT Timeline:", intel["acat_timeline"])
            if intel.get("special_notes"):
                pdf.kv_line("Notes:", intel["special_notes"])

        if acc.get("validation_status") and acc["validation_status"] != "VALID":
            pdf.ln(1)
            pdf.info_box(
                f"VALIDATION {acc['validation_status']}: "
                + "; ".join(acc.get("validation_issues", []) or []),
                _YELLOW_700 if acc["validation_status"] == "WARNING" else _RED_700,
            )

        assets = acc.get("assets", [])
        if assets:
            pdf.ln(2)
            pdf.subsection_title(f"Positions ({len(assets)})")
            fixed = 28 + 55 + 26 + 34 + 28 + 34
            col_w = [28, 55, 26, 34, 28, 34, _remaining_width(pdf, fixed)]
            _table_header(pdf, [
                "Symbol", "Description", "Shares", "Market Value",
                "Classification", "Status", "Routing Notes",
            ], col_w)
            for pos in assets:
                eff_status = pos.get("effective_status") or pos.get("transfer_eligible") or ""
                eff_notes = pos.get("effective_notes") or pos.get("transfer_notes") or ""
                override_marker = " *" if pos.get("override_status") else ""
                _table_row(pdf, [
                    pos.get("symbol") or "-",
                    pos.get("description") or "",
                    _fmt_number(pos.get("quantity")),
                    _fmt_currency(pos.get("market_value")),
                    pos.get("asset_type") or pos.get("type") or "",
                    eff_status + override_marker,
                    eff_notes or "",
                ], col_w, status_col=5)

            overridden = [p for p in assets if p.get("override_status")]
            if overridden:
                pdf.set_font("Helvetica", "I", 7)
                pdf.set_text_color(*_SLATE_500)
                pdf.cell(0, 5, "* Indicates ops override applied", new_x="LMARGIN", new_y="NEXT")

        pdf.ln(6)

    _render_destinations_section(pdf, household, accounts)


def _render_destinations_section(pdf: HouseholdPDF, household: dict, accounts: list):
    """Render the 'Accounts to be Opened at Apex' destination mapping: each
    transferring-in source account, the destination it maps to, whether the
    account still needs to be opened, and a stale-statement flag."""
    destinations = household.get("destinations", [])
    if not destinations:
        return

    _check_page_space(pdf, 50)
    pdf.section_title("Accounts to be Opened at Apex")

    acct_by_key = {}
    for acc in accounts:
        acct_by_key[(acc.get("custodian") or "", acc.get("account_number") or "")] = acc

    fixed = 26 + 30 + 44 + 44 + 30 + 20 + 20
    col_w = [26, 30, 44, 44, 30, 20, 20, _remaining_width(pdf, fixed)]
    _table_header(pdf, [
        "Transfer In Acct #", "In Type", "In Owner",
        "Transfers To Owner", "To Type", "Apex #", "Needs Open?", "Statement Status",
    ], col_w)

    stale_count = 0
    for d in destinations:
        apex = d.get("existing_apex_number") or (d.get("suggestion") or {}).get("suggested_apex_number") or ""
        needs_open = "YES" if d.get("needs_to_be_opened") else "No"
        sources = d.get("sources", [])
        if not sources:
            _table_row(pdf, [
                "-", "-", "-", d.get("owner") or "-",
                d.get("target_account_type") or "-", apex or "-", needs_open, "-",
            ], col_w, right_cols=())
            continue
        for s in sources:
            acc = acct_by_key.get((s.get("custodian") or "", s.get("account_number") or ""))
            if acc and acc.get("is_stale"):
                stale_count += 1
                age = acc.get("statement_age_days")
                stmt = f"NEW STATEMENT NEEDED ({age}d old)" if age is not None else "NEW STATEMENT NEEDED"
            else:
                stmt = "Current"
            _table_row(pdf, [
                s.get("account_number") or (acc.get("account_number") if acc else "") or "-",
                (acc.get("account_type") if acc else "") or "-",
                (acc.get("account_holder") if acc else "") or "-",
                d.get("owner") or "-",
                d.get("target_account_type") or "-",
                apex or "-",
                needs_open,
                stmt,
            ], col_w, right_cols=())

    if stale_count:
        pdf.ln(1)
        pdf.info_box(
            f"{stale_count} transferring-in account(s) ran on a stale statement -- "
            "request fresh statements before initiating transfer.",
            _YELLOW_700,
        )
    pdf.ln(6)


def _add_disclaimer(pdf: HouseholdPDF):
    _check_page_space(pdf, 25)
    pdf.set_draw_color(*_SLATE_200)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 7)
    pdf.set_text_color(*_SLATE_500)
    generated = datetime.now(ET).strftime("%B %d, %Y at %I:%M %p ET")
    pdf.multi_cell(0, 4, (
        f"Report generated {generated}. "
        "This report is confidential and intended for internal use by Cedar Ridge Wealth. "
        "Transfer eligibility classifications are determined by an automated rule engine and should "
        "be verified by the operations team before initiating any ACAT or liquidation transfers."
    ))


# ---------------------------------------------------------------------------
# Table drawing helpers
# ---------------------------------------------------------------------------

def _remaining_width(pdf: FPDF, used: float) -> float:
    return pdf.w - pdf.l_margin - pdf.r_margin - used


def _check_page_space(pdf: FPDF, needed: float):
    if pdf.get_y() + needed > pdf.h - pdf.b_margin:
        pdf.add_page()


def _table_header(pdf: FPDF, headers: list[str], col_widths: list[float]):
    pdf.set_font("Helvetica", "B", 7)
    pdf.set_text_color(*_SLATE_500)
    pdf.set_fill_color(*_SLATE_50)
    for i, h in enumerate(headers):
        align = "R" if h in ("Shares", "Market Value") else "L"
        pdf.cell(col_widths[i], 7, h.upper(), fill=True, align=align)
    pdf.ln()
    pdf.set_draw_color(*_SLATE_200)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())


def _table_row(
    pdf: FPDF,
    values: list[str],
    col_widths: list[float],
    status_col: int | None = None,
    right_cols: tuple = (2, 3),
):
    """Render a single table row with per-cell text wrapping.

    Computes the number of wrapped lines each cell will occupy (via a dry-run
    measurement) and renders every cell at a uniform height equal to the
    tallest cell so rows stay aligned.
    """
    pdf.set_font("Helvetica", "", 8)
    line_h = 4.2

    safe_values = [_safe(v) if v is not None else "" for v in values]

    line_counts: list[int] = []
    for i, safe_val in enumerate(safe_values):
        if not safe_val:
            line_counts.append(1)
            continue
        lines = pdf.multi_cell(
            col_widths[i],
            line_h,
            safe_val,
            dry_run=True,
            output="LINES",
        )
        line_counts.append(max(1, len(lines)))

    max_lines = max(line_counts)
    row_h = max_lines * line_h + 1.5

    _check_page_space(pdf, row_h)

    y_start = pdf.get_y()
    x_cursor = pdf.l_margin

    with pdf.unbreakable() as guard:
        for i, safe_val in enumerate(safe_values):
            align = "R" if i in right_cols else "L"
            guard.set_xy(x_cursor, y_start)

            if status_col is not None and i == status_col:
                clean = safe_val.replace(" *", "")
                color = _STATUS_COLORS.get(clean, _SLATE_700)
                guard.set_font("Helvetica", "B", 8)
                guard.set_text_color(*color)
                guard.multi_cell(col_widths[i], line_h, safe_val, align=align)
                guard.set_font("Helvetica", "", 8)
                guard.set_text_color(*_SLATE_900)
            else:
                guard.set_text_color(*_SLATE_900)
                guard.multi_cell(col_widths[i], line_h, safe_val, align=align)

            x_cursor += col_widths[i]

    pdf.set_xy(pdf.l_margin, y_start + row_h)
