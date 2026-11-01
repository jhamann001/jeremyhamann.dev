# Cost-Basis Feed — Warehouse

The drift tax-enrichment layer reads cost basis from database 4
(`Prod-redshift`, schema `apex`) via **aggregated/narrowed native SQL** run
through Warehouse's `/api/dataset` endpoint (NOT saved questions). Three queries,
all in `warehouse.ts`:

| Query                     | Source table(s)                                                              | Returns                                             |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `fetchCostBasisData()`    | `apex_cost_basis_open_lot_full_refresh` ∪ `apex_cost_basis_open_lot_refresh` | current OPEN lots + freshness (~50k rows × 11 cols) |
| `fetchRealizedGainsYtd()` | `apex_cost_basis_closed_lot_full_refresh`                                    | per-account YTD realized ST/LT (~129 rows)          |
| `fetchOwnershipTypes()`   | `apex_daily_accounts`                                                        | per-account ownership_type (~450 rows)              |

**Why native SQL, not the raw cards 6304/6172:** those are `SELECT *` and — even
with a 30-day filter — return ~4 weekly snapshots × 50 columns (~188k rows),
which OOM-killed the 1 GB Cloud Run container on the nightly run. The open-lots
query filters to the latest snapshot ∪ daily deltas and selects only the ~11
needed columns + does the merge/dedup server-side, cutting the payload ~10×.

The merge (latest full snapshot ∪ daily rows after it, deduped by `open_lot_id`,
OPEN-only) and freshness (`process_date` + `gluerundatetime` repeated on every
row) are computed in SQL; `fetchCostBasisData()` parses rows → `OpenLot[]` and
reads freshness off the first row. Read path:
`fetchCostBasisData()` → `enrichAccountsWithCostBasis()` + `evaluateCostBasisFreshness()`.

Degrades gracefully: gated on `isWarehouseQueryConfigured()` (URL + API key);
realized/ownership each have their own try/catch; a cost-basis failure never
aborts the drift run. NB: `/api/dataset` requires the API key's group to have
**native-query permission** — if absent, these fail cleanly (caught, no enrichment),
they do NOT OOM.

## Verified facts (2026-06)

- `account_id` IS the 26-char Apex ULID — joins directly to positions/household.
- `acquisition_event_type` values seen: `BUY`, `TRANSFER_EXTERNAL` (ACAT),
  `TRANSFER_INTERNAL`, `SPIN_OFF_ADJUSTMENT`, … — only `TRANSFER_EXTERNAL`
  flags a transfer-in; all others are treated as non-transfer.
- `term` ∈ {`SHORT_TERM`, `LONG_TERM`} (pre-computed).
- `open_lot_id` is a unique key; daily deltas after a weekly snapshot are 100% new IDs.
- `_full_refresh` = WEEKLY snapshot; `_refresh` = business-DAILY deltas.
- `process_date` = business date the data represents (content age).
  `gluerundatetime` = when the Glue ETL job loaded the rows (pipeline health), T+1.

## History note (cards 6304/6172 retired from this path)

An earlier cut read the raw `SELECT *` cards 6304/6172 and merged in code. Even
with a "Previous 30 days" card filter that returned ~188k rows × 50 cols (4
weekly snapshots) and OOM-killed the 1 GB Cloud Run container on the nightly
run. Replaced by the narrowed native query above (latest snapshot ∪ daily
deltas, ~11 cols, server-side merge → ~50k rows). The cards still exist for
ad-hoc use; the app no longer reads them, and the `WAREHOUSE_OPEN_LOTS_*`
env vars are gone.

## Staleness thresholds

Set in `costBasisFreshness.ts` (`DEFAULT_FRESHNESS_THRESHOLDS`) — STRICT by
policy (stale cost basis is not trustworthy):

| Signal                               | WARN at age ≥ | CRITICAL at age ≥ | Rationale                                              |
| ------------------------------------ | ------------- | ----------------- | ------------------------------------------------------ |
| full `process_date` (content)        | 8 days        | 11 days           | should be last Friday's; 8d = a Friday was missed      |
| daily `process_date` (content)       | 2 days        | 3 days            | T-1 load makes 1d normal; 2d = a daily load was missed |
| pipeline `gluerundatetime` (ETL ran) | 2 days        | 4 days            | loader runs every business day                         |

`evaluateCostBasisFreshness()` reports the worst of the three (pipeline = freshest
`gluerundatetime` across both tables); the runner posts a Slack heads-up via
`postCostBasisFreshnessAlert()` (gated on `DRIFT_ALERTS_ENABLED`). Tunable via the
`thresholds` arg if normal weekend/holiday gaps prove noisy.
