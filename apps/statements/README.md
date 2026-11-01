# Statement Analyzer

Reads a household's brokerage statements and decides, position by position, how each holding can move to the
firm's custodian: transfer in kind by ACAT, liquidate and move as cash, review by a person, or unsupported. The
operations team then works the result: overrides with an audit trail, account-type changes, destination accounts
to open, and a PDF for the advisor.

This copy runs on synthetic data for a fictional firm, Cedar Ridge Wealth. Every person, account and statement in
it is invented.

## What it does

- **Intake:** statements (PDF, PNG, JPEG) arrive in one folder per household. A pre-screen rejects documents
  that aren't statements or holdings reports; old statements are still read, and flagged stale.
- **Extraction:** a model reads each statement into accounts and positions. Every extraction is checked against
  the statement's own totals; a value mismatch forces the whole account to review rather than trusting it.
- **Classification:** a deterministic, layered rule chain decides each position's outcome from the account type,
  the asset type, the receiving custodian's account and asset rules, fund-company restrictions and the ticker's
  classification. The model never decides eligibility.
- **Cross-account guards:** duplicate statements collapse; a portfolio copied into several registrations, or
  account totals that overshoot the statement total, are caught and sent to review.
- **The operations view:** per-position overrides (with who and when), soft delete and restore, account-type
  changes that reclassify the account, a "transferring" flag, destination accounts to open, and an advisor view.
- **Runs:** each processing of a household is a run; earlier runs stay readable and are marked superseded.
- **Outputs:** a household PDF and an all-households PDF.

## Stack

Python 3.11 · FastAPI · PostgreSQL (psycopg2) · fpdf2 · React 19 · Vite 8 · Tailwind 4 · lucide-react ·
unittest and pytest.

## Layout

| Path | What's there |
|---|---|
| `automation_pipeline.py` | Intake, extraction, classification, validation and consolidation |
| `server.py` | The API and the static frontend |
| `db.py` | The schema (created in code by `ensure_schema`) and every query |
| `auth.py` | Request authentication and roles |
| `demo.py` | Demo mode: the sign-in personas, their session cookie and the routes the demo refuses |
| `samples.py` | The demo's sample statements: nine households, twelve PDFs, generated on demand |
| `demo_reset.py` | The demo's seed and its nightly reset |
| `stand_ins.py` | The demo's stand-ins: the model replay, the reference lookups and the sample intake |
| `reference_data.py`, `custodian_library.py` | Reference data in place of the firm's Notion databases |
| `tools/` | `export_custodian_library.mjs`: regenerates `custodian_library.py` from the tracker's library |
| `pdf_export.py` | Household and all-households PDFs |
| `holdings_transferability.py`, `account_resolution.py` | The machine-readable holdings view and account matching |
| `mcp_server.py` | A Model Context Protocol server: household reads, PDFs and the status override |
| `apex_rules.csv` | The receiving custodian's account and asset rules |
| `frontend/` | The React app |
| `docs/` | `ARCHITECTURE.md` and the partial-transfer contract |

## Demo mode

`DEMO_MODE=on` (never with `APP_ENV=production`) runs the public demo:

- **Sign-in:** two personas instead of Google sign-in. Jordan Reyes has the `ops` role; Rachel Moss is an
  `advisor`. Choosing one sets a signed, HttpOnly session cookie (`SESSION_SECRET`, 32 characters or more), and
  the role is read from the users table on every request. The personas can't be demoted or removed.
- **Outbox:** the Slack scan summary and "Save to Drive" are kept in an Outbox screen instead of being sent.
- **Sample statements:** in place of the Drive folder, Operations picks sample households and runs them
  through the same pipeline. There is no live model and no model bill: each statement's pre-screen and extraction
  answers are prepared from the statement's own data, in the JSON the prompts ask the model for, and the app's
  own code takes them from there. A PDF or prompt with no prepared answer is refused. The panel shows a run's
  progress for 45 to 60 seconds before its results, about what the model takes to read a statement. The four
  Notion lookups are served from `reference_data.py`, `custodian_library.py` (the Transfer Tracker demo's
  custodian library) and `apex_rules.csv`.
- **Switched off:** the scheduler's routes, the Drive scan, the machine APIs and MCP answer 404, and every
  state-changing request must come from the app's own pages.
- **Reset:** `demo_reset.py` puts the database back to its seed daily at 07:00 UTC (the Worker's cron calls
  `POST /api/internal/demo-reset` with `DEMO_RESET_TOKEN`) and at each deploy (`python demo_reset.py`). The seed
  is the nine sample households plus the synthetic universe's thirty others, as statements from their previous
  custodians, all run through the real pipeline, with a client roster from the same universe. The whole reset is
  one transaction: a failure leaves the previous day's data.
- **Theme:** light and dark. `public/theme.js` applies the saved choice (`localStorage` "theme", which the
  portfolio site's hand-off also writes) or the system setting before the page paints; `src/theme.css` swaps the
  palette rather than adding a dark variant to every class.
- **Limits:** 300 runs between resets, 10 sample runs per visitor in 10 minutes, 25 users, 12 destinations per
  client, 500 Outbox entries, short free text (notes 500 characters), and request bodies up to 128 KB.

## Tests

```bash
pip install -r requirements.txt pytest
python -m pytest
```

Tests that need a database run when `TEST_DATABASE_URL` points at a disposable Postgres; without it they skip.
