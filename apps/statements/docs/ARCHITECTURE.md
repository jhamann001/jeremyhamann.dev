# Architecture

One Python service and one React app. The service owns the pipeline, the API and the database schema; the app is
built into static files that the service serves.

## Processing a household

`process_client_folder` in `automation_pipeline.py` runs once per household folder:

1. **Pre-screen.** Each document is classified by type (`classify_document_with_gemini`) and gated
   (`evaluate_doc_gate`): types that aren't statements or holdings reports, such as tax forms and bank
   statements, are rejected. Age is not a reason to reject; a statement older than `STATEMENT_STALE_DAYS` (60 by
   default) is still read, and flagged stale.
2. **Extraction.** `analyze_document_with_gemini` reads the statement into accounts and positions as JSON.
3. **Validation.** `validate_extraction` reconciles each account's positions against its printed total. A
   mismatch marks the account `WARNING` and forces every position to `REVIEW`, keeping the original outcome in
   `original_transfer_eligible`.
4. **Classification.** For each position, `classify_asset_type` settles what the holding is, and
   `classify_transfer_eligibility` decides what happens to it (below).
5. **Consolidation.** `consolidate_analyses` merges the documents into one household: duplicate copies of a
   statement collapse (`_dedup_accounts`, newest statement date wins), and `detect_cross_account_duplicates`
   catches a portfolio copied into several registrations.
6. **Write.** The household, its accounts and positions are written as a new run; earlier runs of the same folder
   are marked superseded, not deleted.

## The eligibility chain

`classify_transfer_eligibility` is pure and deterministic: a fixed priority order of rules, first match wins. It
returns one of four outcomes with a note saying which rule decided:

| Outcome | Meaning |
|---|---|
| `ACAT` | Transfers in kind |
| `LIQUIDATE` | Sold at the sending firm and moved as cash |
| `REVIEW` | A person decides (titling, restrictions, anything the rules can't settle) |
| `UNSUPPORTED` | The receiving custodian can't hold it |

The inputs are the account type (and whether it is a rollover), the asset type, the receiving custodian's
account-level and asset-level rules (`apex_rules.csv`), fund-company restrictions, and the ticker's
classification. The model's output is an input to these rules; it never sets an outcome itself.

Changing an account's type re-runs the chain for that account (`reclassify_for_new_account_type`). A person's
override is stored on the position with who and when, and `positions_effective` applies overrides and soft
deletes for every read.

## Data

PostgreSQL, created and migrated in code by `db.ensure_schema` on startup.

| Table | Holds |
|---|---|
| `households` | One row per run: the client, the source folder, run number, totals, superseded-by |
| `accounts` | Accounts in a run, with registration, totals, validation status and staleness |
| `positions` | Positions with outcome, notes, overrides and soft-delete fields |
| `target_accounts`, `source_account_links` | Destination accounts to open at the receiving custodian, and which source accounts feed each |
| `active_accounts_roster` | Accounts already open, used to suggest destinations |
| `users` | Email and role (`ops` or `advisor`) |
| `mcp_tokens` | MCP bearer tokens, stored as SHA-256 hashes |
| `outbox` | Demo mode: the Slack posts and Drive saves captured instead of sent |

Views: `positions_effective` (overrides applied, soft deletes removed) and `household_summary`.

## Access

| Caller | How it authenticates | Reaches |
|---|---|---|
| A person in the app | A Google ID token with a verified email, then a row in `users` | Reads for both roles; edits for `ops` |
| A demo visitor | A persona's signed session cookie, then a row in `users` | The same, by the persona's role |
| The scheduler | An OIDC token (`SCAN_ALLOWED_SA` and `SCAN_EXPECTED_AUDIENCE`) or a shared scan secret | `POST /scan` and the backfills |
| Other services | An OIDC token for this service from an allowlisted service account: `POSITIONS_API_ALLOWED_SAS` to read, `OPS_PORTAL_EDIT_ALLOWED_SAS` to edit | `/api/v1/positions`, `/api/v1/position-accounts`, `/api/v1/households`, the household PDFs; the edit routes |
| An MCP client | A minted bearer token | `/mcp` |

Every machine check fails closed: with its allowlist or audience unset, every token is refused. In demo mode
only the cookie is read, and the scheduler, machine-API and MCP routes answer 404.

## Outside services

| Service | Used for | Where |
|---|---|---|
| Google Drive | Statement intake and "Save to Drive" | `build_google_services` and the Drive helpers |
| Vertex AI (Gemini) | Document pre-screen and extraction | `classify_document_with_gemini`, `analyze_document_with_gemini` |
| Notion | Fund restrictions, custodian contacts, ticker classification and custodian rules | `NotionRestrictionDB`, `NotionCustodianDB`, `NotionTickerDB`, `NotionApexRulesDB` |
| A data warehouse | Matching accounts already open at the custodian | `WarehouseClient` |
| Slack | A summary after each scan | `send_slack_notification` |

In demo mode each one has a stand-in behind the same interface (`stand_ins.py`): sample statements in place of
Drive (`SampleStatementSource`, the same four methods as `DriveSource`), answers prepared from each statement in
place of Gemini (`ReplayGenaiClient`, `prepared_answers`), reference files in place of Notion, and the Outbox in
place of Slack and "Save to Drive". The warehouse isn't configured, so destination accounts are suggested from the
roster alone, which the demo loads from the synthetic universe.

The demo's data is rebuilt daily by `demo_reset.reset_demo`: it empties every table and runs the seed's statements
through `process_client_folder`, holding the pipeline's commits for one of its own, so the rebuild is all or
nothing.
