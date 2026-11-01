"""
The demo's reference data, in place of two of the firm's Notion databases: the mutual fund restriction list and
the security (ticker) classification table. stand_ins.py serves it behind the same lookup classes.

Not the firm's Notion contents: entries for the synthetic universe's securities (synthetic/world.json) and the
sample statements' planted cases, written for the demo. A few securities are left out on purpose, so their rows
show the pipeline's own fallbacks: the foreign ordinary share and the preferred go to review because the ticker
table can't confirm them, and the Treasury note is recognized from its CUSIP-style identifier.

The other two lookups come from files already in the app: the receiving custodian's rules (apex_rules.csv) and
the Transfer Tracker demo's custodian library (custodian_library.py).
"""

# Mutual fund restriction list. "Omni" means the receiving custodian holds the fund in its omnibus account, so it
# transfers in kind; any other value sends the fund to review with that value shown.
FUND_RESTRICTIONS: dict[str, str] = {
    "BBGLX": "Not available (proprietary to Edward Jones)",
    "PRGFX": "Omni",
    "PRWCX": "Omni",
    "PRFDX": "Omni",
    "TRBCX": "Direct at fund company only",
    "SWYGX": "Omni",
    "SWPPX": "Omni",
}

# Security classification table: asset type as the pipeline's ticker table records it ("Common Stock" maps to
# Equity), name and exchange. Money market funds aren't listed: the pipeline treats them as cash before it looks
# a symbol up.
TICKERS: dict[str, dict] = {
    "VTI": {"name": "Vanguard Total Stock Market ETF", "asset_type": "ETF", "exchange": "NYSE Arca"},
    "VXUS": {"name": "Vanguard Total International Stock ETF", "asset_type": "ETF", "exchange": "NASDAQ"},
    "AVUV": {"name": "Avantis U.S. Small Cap Value ETF", "asset_type": "ETF", "exchange": "NYSE Arca"},
    "VNQ": {"name": "Vanguard Real Estate ETF", "asset_type": "ETF", "exchange": "NYSE Arca"},
    "BND": {"name": "Vanguard Total Bond Market ETF", "asset_type": "ETF", "exchange": "NASDAQ"},
    "AGG": {"name": "iShares Core U.S. Aggregate Bond ETF", "asset_type": "ETF", "exchange": "NYSE Arca"},
    "VGSH": {"name": "Vanguard Short-Term Treasury ETF", "asset_type": "ETF", "exchange": "NASDAQ"},
    "SCHR": {"name": "Schwab Intermediate-Term U.S. Treasury ETF", "asset_type": "ETF", "exchange": "NYSE Arca"},
    "VCSH": {"name": "Vanguard Short-Term Corporate Bond ETF", "asset_type": "ETF", "exchange": "NASDAQ"},
    "VTEB": {"name": "Vanguard Tax-Exempt Bond ETF", "asset_type": "ETF", "exchange": "NYSE Arca"},
    "SUB": {"name": "iShares Short-Term National Muni Bond ETF", "asset_type": "ETF", "exchange": "NYSE Arca"},
    "AAPL": {"name": "Apple Inc", "asset_type": "Common Stock", "exchange": "NASDAQ"},
    "MSFT": {"name": "Microsoft Corp", "asset_type": "Common Stock", "exchange": "NASDAQ"},
    "NVDA": {"name": "NVIDIA Corp", "asset_type": "Common Stock", "exchange": "NASDAQ"},
    "BBGLX": {"name": "Bridge Builder Large Cap Growth Fund", "asset_type": "Mutual Fund", "exchange": ""},
    "PRGFX": {"name": "T. Rowe Price Growth Stock Fund", "asset_type": "Mutual Fund", "exchange": ""},
    "PRWCX": {"name": "T. Rowe Price Capital Appreciation Fund", "asset_type": "Mutual Fund", "exchange": ""},
    "PRFDX": {"name": "T. Rowe Price Equity Income Fund", "asset_type": "Mutual Fund", "exchange": ""},
    "TRBCX": {"name": "T. Rowe Price Blue Chip Growth Fund", "asset_type": "Mutual Fund", "exchange": ""},
    "SWYGX": {"name": "Schwab Target 2040 Index Fund", "asset_type": "Mutual Fund", "exchange": ""},
    "SWPPX": {"name": "Schwab S&P 500 Index Fund", "asset_type": "Mutual Fund", "exchange": ""},
}

# How the custodian library's transfer methods read in the custodian notes.
TRANSFER_METHODS: dict[str, str] = {
    "ACAT_API": "Standard ACAT",
    "MANUAL": "Not a standard ACAT: a manual transfer on the custodian's own forms",
    "MIXED": "Depends on the account: some ACAT, some manual",
    "INTERNAL": "Internal transfer",
    "UNCONFIRMED": "Transfer method not yet confirmed",
}
