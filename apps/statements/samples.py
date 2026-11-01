"""
The demo's sample statements: nine household folders, twelve PDFs, generated on demand.

Every statement is invented: the synthetic universe's people (synthetic/world.json), DEMO- account numbers and
illustrative prices. Every page says it is a sample for a portfolio demo and not issued by the firm named on it,
and the layout is plain and generic, never a copy of a custodian's real design.

The bytes are deterministic (a fixed creation date and the core fonts), so a statement's SHA-256 is stable. It
keys the statement's prepared answers (stand_ins.prepared_answers), which are built from these same definitions,
so a change here changes the answers with it.

    python samples.py OUT_DIR     # write every PDF, one folder per household
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fpdf import FPDF
from fpdf.enums import XPos, YPos

# The universe's as-of date. Statement dates are printed as of this day; the replay moves them forward with the
# demo's clock so a fresh statement stays fresh (stand_ins.replay_shift_days).
AS_OF = date(2026, 10, 23)


@dataclass(frozen=True)
class Lot:
    acquired: str            # MM/DD/YYYY, as printed
    quantity: str
    cost_basis: float
    value: float


@dataclass(frozen=True)
class Holding:
    symbol: Optional[str]
    description: str
    quantity: str            # as printed: shares, par or contracts
    price: Optional[float]
    value: float
    cost_basis: Optional[float] = None
    lots: tuple = ()
    registration: Optional[str] = None   # fund-company statements: which registration holds it


@dataclass(frozen=True)
class Account:
    title: str               # the registration as printed
    number: Optional[str]
    holders: str
    holdings: tuple = ()
    cash: float = 0.0
    printed_total: Optional[float] = None   # defaults to the sum; set to plant a value mismatch

    @property
    def computed_total(self) -> float:
        return round(sum(h.value for h in self.holdings) + self.cash, 2)

    @property
    def total(self) -> float:
        return self.printed_total if self.printed_total is not None else self.computed_total


@dataclass(frozen=True)
class Document:
    filename: str
    kind: str                # brokerage | retirement_plan | fund_company | bank | proposal
    issuer: str              # the firm the document claims to be from
    period_start: date
    period_end: date
    accounts: tuple = ()
    investor_number: Optional[str] = None
    plan_name: Optional[str] = None
    prepared_for: Optional[str] = None
    lines: tuple = ()        # bank transactions or proposal rows


@dataclass(frozen=True)
class Sample:
    key: str
    client_name: str         # the household folder's name, as the dashboard lists it
    custodian: str
    shows: str               # one line for the sample panel: what this folder demonstrates
    documents: tuple = field(default_factory=tuple)


def _h(symbol, description, quantity, price, value, cost_basis=None, lots=(), registration=None) -> Holding:
    return Holding(symbol, description, quantity, price, value, cost_basis, tuple(lots), registration)


SEPT = (date(2026, 9, 1), date(2026, 9, 30))

SAMPLES: tuple[Sample, ...] = (
    Sample(
        key="okafor",
        client_name="Okafor Household",
        custodian="Edward Jones",
        shows="Three accounts on one statement. ETFs and stocks clear to ACAT; the Bridge Builder fund and the "
              "option go to review.",
        documents=(Document(
            filename="Okafor_EdwardJones_2026-09.pdf", kind="brokerage", issuer="Edward Jones",
            period_start=SEPT[0], period_end=SEPT[1],
            accounts=(
                Account(
                    title="Joint Tenants with Right of Survivorship (JTWROS)", number="DEMO-4417-7781",
                    holders="Kofi Okafor, Ada Okafor", cash=3912.69,
                    holdings=(
                        _h("VTI", "Vanguard Total Stock Market ETF", "812", 291.40, 236616.80, 168420.00, (
                            Lot("03/14/2019", "500", 82350.00, 145700.00),
                            Lot("08/02/2021", "312", 86070.00, 90916.80),
                        )),
                        _h("MSFT", "Microsoft Corp", "100", 429.38, 42938.00, 24310.00),
                        _h("AAPL", "Apple Inc", "140", 229.80, 32172.00, 13860.00),
                        _h("BND", "Vanguard Total Bond Market ETF", "420", 73.10, 30702.00, 33180.00),
                        _h("BBGLX", "Bridge Builder Large Cap Growth Fund", "2,104.330", 31.62, 66538.91,
                           58900.00),
                    ),
                ),
                Account(
                    title="Roth IRA", number="DEMO-4417-7790", holders="Kofi Okafor", cash=21521.62,
                    holdings=(
                        _h("VXUS", "Vanguard Total International Stock ETF", "1,050", 66.20, 69510.00),
                        _h("AVUV", "Avantis U.S. Small Cap Value ETF", "310", 98.75, 30612.50),
                    ),
                ),
                Account(
                    title="Individual", number="DEMO-4417-7802", holders="Ada Okafor", cash=2151.66,
                    holdings=(
                        _h("NVDA", "NVIDIA Corp", "260", 182.40, 47424.00, 31200.00),
                        _h("AAPL 270115C00250000", "CALL APPLE INC JAN 15 2027 250.00", "2 contracts", 15.70,
                           3140.00, 2480.00),
                    ),
                ),
            ),
        ),),
    ),
    Sample(
        key="delgado",
        client_name="Delgado Family Trust",
        custodian="Charles Schwab",
        shows="A revocable trust. The receiving custodian doesn't support trusts, so every position is "
              "unsupported.",
        documents=(Document(
            filename="DelgadoTrust_Schwab_2026-08.pdf", kind="brokerage", issuer="Charles Schwab",
            period_start=date(2026, 8, 1), period_end=date(2026, 8, 31),
            accounts=(Account(
                title="Revocable Trust - Marisol Delgado TTEE, Delgado Family Trust", number="DEMO-2241-3858",
                holders="Marisol Delgado, Trustee",
                holdings=(
                    _h("VTI", "Vanguard Total Stock Market ETF", "980", 295.00, 289100.00, 201300.00),
                    _h("AGG", "iShares Core U.S. Aggregate Bond ETF", "1,500", 99.40, 149100.00, 156750.00),
                    _h("VTEB", "Vanguard Tax-Exempt Bond ETF", "2,400", 50.30, 120720.00, 121440.00),
                    _h("SWVXX", "Schwab Value Advantage Money Fund", "81,080.000", 1.00, 81080.00, 81080.00),
                ),
            ),),
        ),),
    ),
    Sample(
        key="nakamura",
        client_name="Nakamura Household",
        custodian="Charles Schwab",
        shows="A March statement: read in full, and flagged stale because it is more than 60 days old.",
        documents=(Document(
            filename="Nakamura_Schwab_2026-03.pdf", kind="brokerage", issuer="Charles Schwab",
            period_start=date(2026, 3, 1), period_end=date(2026, 3, 31),
            accounts=(Account(
                title="Traditional IRA", number="DEMO-2241-5518", holders="Ken Nakamura",
                holdings=(
                    _h("VTI", "Vanguard Total Stock Market ETF", "400", 295.00, 118000.00),
                    _h("VXUS", "Vanguard Total International Stock ETF", "900", 66.20, 59580.00),
                    _h("BND", "Vanguard Total Bond Market ETF", "800", 73.10, 58480.00),
                    _h("VGSH", "Vanguard Short-Term Treasury ETF", "500", 58.70, 29350.00),
                    _h("SWVXX", "Schwab Value Advantage Money Fund", "18,690.000", 1.00, 18690.00),
                ),
            ),),
        ),),
    ),
    Sample(
        key="brennan",
        client_name="Brennan Household",
        custodian="Charles Schwab",
        shows="Two documents: a brokerage account that clears to ACAT, and a former employer's 401(k), which is "
              "sold to cash and rolled over.",
        documents=(
            Document(
                filename="Brennan_Schwab_2026-09.pdf", kind="brokerage", issuer="Charles Schwab",
                period_start=SEPT[0], period_end=SEPT[1],
                accounts=(Account(
                    title="Individual", number="DEMO-2241-6631", holders="Maeve Brennan", cash=13045.80,
                    holdings=(
                        _h("VTI", "Vanguard Total Stock Market ETF", "300", 295.00, 88500.00, 61200.00),
                        _h("VNQ", "Vanguard Real Estate ETF", "400", 89.40, 35760.00, 38400.00),
                        _h("MSFT", "Microsoft Corp", "90", 429.38, 38644.20, 21150.00),
                        _h("AGG", "iShares Core U.S. Aggregate Bond ETF", "300", 99.40, 29820.00, 31260.00),
                    ),
                ),),
            ),
            Document(
                filename="Brennan_401k_2026-Q3.pdf", kind="retirement_plan",
                issuer="Schwab Retirement Plan Services",
                period_start=date(2026, 7, 1), period_end=SEPT[1],
                plan_name="Larkspur Freight Co. 401(k) Savings Plan",
                accounts=(Account(
                    title="401(k)", number="DEMO-PLN-1195", holders="Maeve Brennan",
                    holdings=(
                        _h("SWYGX", "Schwab Target 2040 Index Fund", "9,800.000", 18.40, 180320.00),
                        _h("SWPPX", "Schwab S&P 500 Index Fund", "1,200.000", 92.10, 110520.00),
                        _h(None, "Larkspur Stable Value Fund", "27,560.000", 1.00, 27560.00),
                    ),
                ),),
            ),
        ),
    ),
    Sample(
        key="morgan",
        client_name="Morgan Household",
        custodian="BNY Investments",
        shows="A joint account at a custodian that doesn't take standard ACATs: the custodian notes say it needs "
              "its own forms and a medallion signature.",
        documents=(Document(
            filename="Morgan_BNY_2026-09.pdf", kind="brokerage", issuer="BNY Investments",
            period_start=SEPT[0], period_end=SEPT[1],
            accounts=(Account(
                title="Joint Tenants with Right of Survivorship", number="DEMO-8810-2047",
                holders="Tom Morgan, Claire Morgan", cash=12390.00,
                holdings=(
                    _h("VTI", "Vanguard Total Stock Market ETF", "150", 295.00, 44250.00, 30900.00),
                    _h("VNQ", "Vanguard Real Estate ETF", "200", 89.40, 17880.00, 18650.00),
                    _h("BND", "Vanguard Total Bond Market ETF", "300", 73.10, 21930.00, 23610.00),
                ),
            ),),
        ),),
    ),
    Sample(
        key="lindqvist",
        client_name="Lindqvist Household",
        custodian="Fidelity",
        shows="A clean individual account: every position clears to ACAT.",
        documents=(Document(
            filename="Lindqvist_Fidelity_2026-09.pdf", kind="brokerage", issuer="Fidelity",
            period_start=SEPT[0], period_end=SEPT[1],
            accounts=(Account(
                title="Individual - TOD", number="DEMO-7745-0193", holders="Erik Lindqvist",
                holdings=(
                    _h("VTI", "Vanguard Total Stock Market ETF", "100", 295.00, 29500.00, 19850.00),
                    _h("VXUS", "Vanguard Total International Stock ETF", "200", 66.20, 13240.00, 11920.00),
                    _h("AAPL", "Apple Inc", "50", 229.80, 11490.00, 6100.00),
                    _h("SPAXX", "Fidelity Government Money Market", "3,970.000", 1.00, 3970.00, 3970.00),
                ),
            ),),
        ),),
    ),
    Sample(
        key="alvarez",
        client_name="Alvarez Household",
        custodian="Charles Schwab",
        shows="A bank statement the pre-screen turns away, and a brokerage statement with a CUSIP-only Treasury "
              "note, a preferred, a foreign ordinary share and a linked checking account.",
        documents=(
            Document(
                filename="Alvarez_SchwabBank_Checking_2026-09.pdf", kind="bank", issuer="Charles Schwab Bank",
                period_start=SEPT[0], period_end=SEPT[1],
                accounts=(Account(title="Investor Checking", number="DEMO-2241-7319", holders="Lucia Alvarez",
                                  cash=12406.18),),
                lines=(
                    ("09/01/2026", "Beginning balance", None, 14220.55),
                    ("09/03/2026", "Payroll deposit", 6850.00, 21070.55),
                    ("09/08/2026", "Card purchase", -412.37, 20658.18),
                    ("09/15/2026", "Transfer to brokerage DEMO-2241-7302", -5000.00, 15658.18),
                    ("09/22/2026", "Mortgage payment", -3252.00, 12406.18),
                    ("09/30/2026", "Ending balance", None, 12406.18),
                ),
            ),
            Document(
                filename="Alvarez_Schwab_2026-09.pdf", kind="brokerage", issuer="Charles Schwab",
                period_start=SEPT[0], period_end=SEPT[1],
                accounts=(
                    Account(
                        title="Individual", number="DEMO-2241-7302", holders="Lucia Alvarez", cash=4113.00,
                        holdings=(
                            _h("VTI", "Vanguard Total Stock Market ETF", "200", 295.00, 59000.00, 42100.00),
                            _h("9128DEMO4", "US TREASURY NOTE 4.250% DUE 05/15/2029 DTD 05/15/2024",
                               "25,000", 100.42, 25105.00, 24890.00),
                            _h("BAC PRL", "BANK OF AMERICA CORP 7.25% NON-CUM PERP CONV PFD SER L", "10",
                               1265.00, 12650.00, 12480.00),
                            _h("NSRGF", "NESTLE SA REG SHS", "120", 88.60, 10632.00, 11760.00),
                        ),
                    ),
                    Account(
                        title="Schwab Bank Investor Checking (linked)", number="DEMO-2241-7319",
                        holders="Lucia Alvarez", cash=12406.18,
                    ),
                ),
            ),
        ),
    ),
    Sample(
        key="rossi",
        client_name="Rossi Household",
        custodian="Fidelity",
        shows="A statement whose positions don't add up to its printed total, so the whole account goes to "
              "review; and a hypothetical proposal the pre-screen turns away.",
        documents=(
            Document(
                filename="Rossi_Fidelity_2026-09.pdf", kind="brokerage", issuer="Fidelity",
                period_start=SEPT[0], period_end=SEPT[1],
                accounts=(Account(
                    title="Individual", number="DEMO-7745-2210", holders="Anthony Rossi",
                    printed_total=127600.00,
                    holdings=(
                        _h("VTI", "Vanguard Total Stock Market ETF", "200", 295.00, 59000.00, 44800.00),
                        _h("AVUV", "Avantis U.S. Small Cap Value ETF", "250", 98.75, 24687.50, 22100.00),
                        _h("VCSH", "Vanguard Short-Term Corporate Bond ETF", "300", 79.30, 23790.00, 23580.00),
                        _h("SPAXX", "Fidelity Government Money Market", "14,122.500", 1.00, 14122.50,
                           14122.50),
                    ),
                ),),
            ),
            Document(
                filename="Rossi_Proposal_Hypothetical.pdf", kind="proposal",
                issuer="Cedar Ridge Wealth", period_start=SEPT[0], period_end=SEPT[1],
                prepared_for="Anthony Rossi",
                lines=(
                    ("VTI", "Vanguard Total Stock Market ETF", 0.55, 70180.00),
                    ("VXUS", "Vanguard Total International Stock ETF", 0.25, 31900.00),
                    ("BND", "Vanguard Total Bond Market ETF", 0.20, 25520.00),
                ),
            ),
        ),
    ),
    Sample(
        key="chen",
        client_name="Chen-Ashby Household",
        custodian="T. Rowe Price",
        shows="A fund-company statement: two registrations under one investor number with no account numbers. "
              "The extraction must give each fund to exactly one registration.",
        documents=(Document(
            filename="Chen_TRowePrice_2026-09.pdf", kind="fund_company", issuer="T. Rowe Price",
            period_start=date(2026, 7, 1), period_end=SEPT[1], investor_number="DEMO-INV-30418",
            accounts=(
                Account(
                    title="Roth IRA", number=None, holders="Grace Chen",
                    holdings=(
                        _h("PRGFX", "T. Rowe Price Growth Stock Fund", "410.250", 98.20, 40286.55,
                           registration="Roth IRA"),
                        _h("PRWCX", "T. Rowe Price Capital Appreciation Fund", "1,020.000", 35.40, 36108.00,
                           registration="Roth IRA"),
                    ),
                ),
                Account(
                    title="Rollover IRA", number=None, holders="Grace Chen",
                    holdings=(
                        _h("PRFDX", "T. Rowe Price Equity Income Fund", "1,150.400", 38.10, 43830.24,
                           registration="Rollover IRA"),
                        _h("TRBCX", "T. Rowe Price Blue Chip Growth Fund", "210.000", 172.50, 36225.00,
                           registration="Rollover IRA"),
                    ),
                ),
            ),
        ),),
    ),
)

SAMPLES_BY_KEY = {s.key: s for s in SAMPLES}


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _money(v: Optional[float]) -> str:
    return "" if v is None else f"{v:,.2f}"


def _d(d: date) -> str:
    return d.strftime("%m/%d/%Y")


class _Statement(FPDF):
    def __init__(self, footer_text: str):
        super().__init__(orientation="P", unit="mm", format="Letter")
        self._footer_text = footer_text
        self.set_auto_page_break(True, margin=20)
        self.set_margins(15, 15, 15)
        self.set_creation_date(datetime(AS_OF.year, AS_OF.month, AS_OF.day, tzinfo=timezone.utc))

    def footer(self):
        self.set_y(-14)
        self.set_font("Helvetica", "I", 7.5)
        self.set_text_color(110, 110, 110)
        self.cell(0, 4, self._footer_text, new_x=XPos.LMARGIN, new_y=YPos.NEXT, align="C")
        self.cell(0, 4, f"Page {self.page_no()}", align="C")
        self.set_text_color(0, 0, 0)


def _line(pdf: FPDF, text: str, size: float = 9, style: str = "", h: float = 5):
    pdf.set_font("Helvetica", style, size)
    pdf.cell(0, h, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)


def _header(pdf: FPDF, doc: Document, title: str):
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(110, 9, doc.issuer)
    pdf.set_font("Helvetica", "", 9)
    pdf.cell(0, 9, title, align="R", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.cell(110, 5, "")
    pdf.cell(0, 5, f"Statement period: {_d(doc.period_start)} - {_d(doc.period_end)}", align="R",
             new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.cell(110, 5, "")
    pdf.cell(0, 5, f"Statement date: {_d(doc.period_end)}", align="R", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(2)
    pdf.set_draw_color(150, 150, 150)
    pdf.line(15, pdf.get_y(), 200.9, pdf.get_y())
    pdf.ln(4)


_COLS = (("Symbol", 34, "L"), ("Description", 64, "L"), ("Quantity", 22, "R"), ("Price", 18, "R"),
         ("Market value", 24, "R"), ("Cost basis", 23.9, "R"))


def _row(pdf: FPDF, cells, style: str = "", size: float = 8):
    pdf.set_font("Helvetica", style, size)
    for (_, width, align), text in zip(_COLS, cells):
        pdf.cell(width, 5, text, align=align)
    pdf.ln(5)


def _holdings_table(pdf: FPDF, account: Account, show_basis: bool):
    _row(pdf, [c[0] if (c[0] != "Cost basis" or show_basis) else "" for c in _COLS], style="B")
    for h in account.holdings:
        _row(pdf, [h.symbol or "", h.description[:44], h.quantity, _money(h.price), _money(h.value),
                   _money(h.cost_basis) if show_basis else ""])
        if len(h.description) > 44:
            _row(pdf, ["", h.description[44:88], "", "", "", ""])
        for lot in h.lots:
            _row(pdf, ["", f"  Lot acquired {lot.acquired}", lot.quantity, "", _money(lot.value),
                       _money(lot.cost_basis)], size=7.5)
    if account.cash:
        _row(pdf, ["", "Cash and sweep balance", "", "", _money(account.cash), ""])
    _row(pdf, ["", "Total account value", "", "", _money(account.total), ""], style="B")


def _render_brokerage(pdf: _Statement, doc: Document):
    _header(pdf, doc, "Account statement")
    accounts = doc.accounts
    _line(pdf, "Portfolio summary", 11, "B", 7)
    for a in accounts:
        pdf.set_font("Helvetica", "", 9)
        pdf.cell(130, 5, f"{a.title}  ({a.number})")
        pdf.cell(0, 5, _money(a.total), align="R", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(130, 6, "Total portfolio value")
    pdf.cell(0, 6, _money(round(sum(a.total for a in accounts), 2)), align="R", new_x=XPos.LMARGIN,
             new_y=YPos.NEXT)
    pdf.ln(4)
    for a in accounts:
        _line(pdf, a.title, 11, "B", 7)
        _line(pdf, f"Account number: {a.number}    Account holder(s): {a.holders}", 8.5)
        pdf.ln(1)
        if a.holdings:
            taxable = not any(k in a.title for k in ("IRA", "401(k)"))
            _holdings_table(pdf, a, show_basis=taxable)
        else:
            _line(pdf, f"Available balance: {_money(a.cash)}", 9)
            _line(pdf, "This account holds cash only. Balances are FDIC-insured deposits, not securities.", 8)
        pdf.ln(5)


def _render_retirement_plan(pdf: _Statement, doc: Document):
    _header(pdf, doc, "Retirement plan statement")
    a = doc.accounts[0]
    _line(pdf, doc.plan_name or "", 11, "B", 7)
    _line(pdf, f"Participant: {a.holders}    Plan account: {a.number}    Account type: {a.title}", 8.5)
    _line(pdf, "Employment status: separated from service. Vested balance: 100%.", 8.5)
    pdf.ln(2)
    _line(pdf, "Your investments", 10, "B", 6)
    _holdings_table(pdf, a, show_basis=False)


def _render_fund_company(pdf: _Statement, doc: Document):
    _header(pdf, doc, "Investor statement")
    holders = doc.accounts[0].holders
    _line(pdf, f"Investor: {holders}    Investor number: {doc.investor_number}", 9)
    _line(pdf, "Your registrations share this investor number.", 8.5)
    pdf.ln(2)
    _line(pdf, "Portfolio overview", 11, "B", 7)
    for a in doc.accounts:
        _line(pdf, f"{a.title}", 10, "B", 6)
        _holdings_table(pdf, a, show_basis=False)
        pdf.ln(3)
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(130, 6, "Mutual fund portfolio value")
    pdf.cell(0, 6, _money(round(sum(a.total for a in doc.accounts), 2)), align="R", new_x=XPos.LMARGIN,
             new_y=YPos.NEXT)
    pdf.ln(4)
    _line(pdf, "Transaction activity", 11, "B", 7)
    pdf.set_font("Helvetica", "B", 8)
    for text, width in (("Date", 22), ("Fund", 84), ("Registration", 26), ("Transaction", 32), ("Amount", 21)):
        pdf.cell(width, 5, text)
    pdf.ln(5)
    pdf.set_font("Helvetica", "", 8)
    for a in doc.accounts:
        for h in a.holdings:
            amount = round(h.value * 0.004, 2)
            for text, width in ((_d(doc.period_end), 22), (f"{h.symbol} {h.description}", 84),
                                (h.registration or "", 26), ("Dividend reinvested", 32), (_money(amount), 21)):
                pdf.cell(width, 5, text)
            pdf.ln(5)


def _render_bank(pdf: _Statement, doc: Document):
    _header(pdf, doc, "Checking account statement")
    a = doc.accounts[0]
    _line(pdf, f"{a.title}    Account number: {a.number}    Account holder: {a.holders}", 9)
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 8.5)
    for text, width, align in (("Date", 25, "L"), ("Description", 95, "L"), ("Amount", 30, "R"),
                               ("Balance", 30, "R")):
        pdf.cell(width, 5, text, align=align)
    pdf.ln(5)
    pdf.set_font("Helvetica", "", 8.5)
    for when, what, amount, balance in doc.lines:
        for text, width, align in ((when, 25, "L"), (what, 95, "L"), (_money(amount), 30, "R"),
                                   (_money(balance), 30, "R")):
            pdf.cell(width, 5, text, align=align)
        pdf.ln(5)
    pdf.ln(3)
    _line(pdf, "Deposits are FDIC-insured up to applicable limits. This is a bank deposit account, not a "
               "brokerage account.", 8)


def _render_proposal(pdf: _Statement, doc: Document):
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 15)
    pdf.cell(0, 9, "Hypothetical Portfolio Illustration", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    _line(pdf, f"Prepared for {doc.prepared_for} by {doc.issuer}. Proposal date: {_d(doc.period_end)}", 9)
    _line(pdf, "HYPOTHETICAL. For illustration only. This is not an account statement and does not show "
               "actual holdings.", 8.5, "B")
    pdf.ln(3)
    invested = round(sum(row[3] for row in doc.lines), 2)
    _line(pdf, f"Net amount invested: {_money(invested)}    Benchmark: MSCI ACWI", 9)
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 8.5)
    for text, width, align in (("Symbol", 25, "L"), ("Proposed holding", 85, "L"), ("Weight", 25, "R"),
                               ("Hypothetical amount", 45, "R")):
        pdf.cell(width, 5, text, align=align)
    pdf.ln(5)
    pdf.set_font("Helvetica", "", 8.5)
    for symbol, name, weight, amount in doc.lines:
        for text, width, align in ((symbol, 25, "L"), (name, 85, "L"), (f"{weight:.0%}", 25, "R"),
                                   (_money(amount), 45, "R")):
            pdf.cell(width, 5, text, align=align)
        pdf.ln(5)
    pdf.ln(4)
    _line(pdf, "Hypothetical growth of the proposed portfolio (assumed 6% a year, before fees)", 9, "B")
    pdf.set_font("Helvetica", "", 8.5)
    for years in (1, 5, 10, 20):
        pdf.cell(40, 5, f"Year {years}")
        pdf.cell(45, 5, _money(round(invested * 1.06 ** years, 2)), align="R", new_x=XPos.LMARGIN,
                 new_y=YPos.NEXT)


_RENDERERS = {
    "brokerage": _render_brokerage,
    "retirement_plan": _render_retirement_plan,
    "fund_company": _render_fund_company,
    "bank": _render_bank,
    "proposal": _render_proposal,
}


def _footer_text(doc: Document) -> str:
    if doc.kind == "proposal":
        return ("Sample document for a portfolio demo. Hypothetical illustration, not an account statement. "
                "Every person and value is invented.")
    return (f"Sample statement for a portfolio demo. Not issued by {doc.issuer}. "
            "Every person, account and value is invented.")


def _shift_us_date(text: str, days: int) -> str:
    return (datetime.strptime(text, "%m/%d/%Y") + timedelta(days=days)).strftime("%m/%d/%Y")


def shift_document(doc: Document, days: int) -> Document:
    """The same statement with every printed date moved forward by *days*: the period, lot acquisition dates and
    bank transaction dates. Security descriptions (a bond's maturity) are left as printed, as the replay leaves
    them. Used only to show a visitor the PDF with the dates the replayed extraction reports."""
    if not days:
        return doc
    accounts = tuple(
        replace(a, holdings=tuple(
            replace(h, lots=tuple(replace(lot, acquired=_shift_us_date(lot.acquired, days)) for lot in h.lots))
            for h in a.holdings))
        for a in doc.accounts)
    lines = tuple((_shift_us_date(line[0], days),) + tuple(line[1:]) for line in doc.lines) if doc.kind == "bank" \
        else doc.lines
    return replace(doc, period_start=doc.period_start + timedelta(days=days),
                   period_end=doc.period_end + timedelta(days=days), accounts=accounts, lines=lines)


def render_document(doc: Document) -> bytes:
    pdf = _Statement(_footer_text(doc))
    pdf.set_title(doc.filename)
    _RENDERERS[doc.kind](pdf, doc)
    return bytes(pdf.output())


def write_all(out_dir: Path) -> list[Path]:
    """Write every sample PDF under out_dir/<sample key>/. Returns the paths."""
    written = []
    for sample in SAMPLES:
        folder = out_dir / sample.key
        folder.mkdir(parents=True, exist_ok=True)
        for doc in sample.documents:
            path = folder / doc.filename
            path.write_bytes(render_document(doc))
            written.append(path)
    return written


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python samples.py OUT_DIR")
    for p in write_all(Path(sys.argv[1])):
        print(p)
