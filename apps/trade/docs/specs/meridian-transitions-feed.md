# Meridian Transitions Feed — Ingestion Spec

Status: **draft / proposal to Meridian**
Owner: drift analysis (`server/src/services/positionDriftAccounts.ts`)
Pattern: mirrors `active_accounts.json` and the templates snapshot — one dated
JSON file dropped to GCS, ingested nightly by the drift runner.

## Purpose

Feed the per-account **Direct Indexing transition plan** (the structured data
behind the Portfolio Transition Report PDF) into the drift analysis so that:

1. Accounts with an active transition are scored against their **glide path**
   (tracking error, capital drift, gain-budget consumed) instead of throwing a
   false "out of tolerance" breach.
2. Every holding's **sector** and **geography** flow in for free — no external
   classification vendor needed.
3. The capital-gains budget and ST/LT split are visible to advisors inside the
   drift surface, reconciled against live cost basis from Warehouse.

## Delivery

- **GCS path:** `gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/transitions/<YYYY-MM-DD>.json`
- One file per generation date, **latest-by-filename** wins (same selection as
  `active_accounts/`). Stale-file gate: 35 days (`STALE_SNAPSHOT_THRESHOLD_DAYS`).
- File is a **batch envelope** holding every account that currently has a live
  transition plan — NOT one file per account. (Same shape philosophy as
  `active_accounts.json`, which carries all accounts in one file.)

## Conventions (important — locks ambiguity)

- **Join key:** `account` MUST be the 26-char Apex trading-account ULID
  (`trading_account_no` in `active_accounts.json`). This is how a transition
  joins to positions, household, and cost basis. `report_id` and
  `account_title` are for display/traceability only, never join keys.
- **Weights & allocations:** percent-scale, `0..100` (e.g. `31.0`, not `0.31`).
  Matches the drift comparator's internal convention (the "B3" percent-scale
  rule). Each holding's `current_wt_pct` across the portfolio should sum to ~100.
- **Tracking error / capital drift:** also percent-scale `0..100` (`4.05`).
- **Dollars:** plain numbers, USD, no formatting (`6300`, not `"$6,300"`).
- **Gains:** signed USD. Positive = gain, negative = loss.
- **Nullable:** use JSON `null`, never `"-"` or `""`. The PDF renders `-`; the
  feed must send `null`.
- **`generated_at`:** ISO-8601. Used for the staleness gate when the filename
  date can't be parsed.

---

## Example (clean, parseable — values taken from report `b94643eb-…`)

```json
{
  "generated_at": "2026-05-15T08:02:11Z",
  "firm_id": "cedarRidge",
  "transition_count": 1,
  "transitions": [
    {
      "report_id": "b94643eb-67e1-4195-bddb-bf5c8fb6d725",
      "account": "01SYNTHJ7G094TRY2A6R126CB3",
      "account_title": "Victor Lang - Brokerage",
      "strategy": "Direct Indexing",
      "status": "active",
      "created_at": "2026-05-15T08:02:11Z",

      "scenario": {
        "name": "$5,000 Max Gains",
        "selected": true,
        "gain_budget_usd": 5000,
        "period_years": 2,
        "rebalance_cadence": "quarterly",
        "tracking_error_vs_di_pct": 4.05,
        "tracking_error_vs_bm_pct": null,
        "capital_drift_pct": 59.88,
        "realized_pnl_usd": 5000,
        "tax_estimate_usd": 2040,
        "realized_short_term_gain_usd": 7831,
        "realized_long_term_gain_usd": 0,
        "realized_short_term_loss_usd": -2831,
        "realized_long_term_loss_usd": 0,
        "position_count_current": 378,
        "position_count_target": 353,
        "trade_count": 250
      },

      "portfolio": {
        "total_market_value_usd": 241000,
        "as_of": "2026-05-14",
        "unrealized_short_term_gain_usd": 47580,
        "unrealized_long_term_gain_usd": 489,
        "unrealized_short_term_loss_usd": -3302,
        "unrealized_long_term_loss_usd": 0
      },

      "sector_allocation": [
        { "sector": "Information Technology", "current_wt_pct": 31.0, "target_wt_pct": 21.2 },
        { "sector": "Bond ETFs", "current_wt_pct": 14.6, "target_wt_pct": 19.5 },
        { "sector": "Financials", "current_wt_pct": 12.3, "target_wt_pct": 12.7 },
        { "sector": "Industrials", "current_wt_pct": 6.4, "target_wt_pct": 9.1 },
        { "sector": "Consumer Discretionary", "current_wt_pct": 7.8, "target_wt_pct": 7.7 },
        { "sector": "Communication Services", "current_wt_pct": 6.7, "target_wt_pct": 7.4 },
        { "sector": "Health Care", "current_wt_pct": 6.2, "target_wt_pct": 5.5 },
        { "sector": "Consumer Staples", "current_wt_pct": 2.1, "target_wt_pct": 4.5 },
        { "sector": "Energy", "current_wt_pct": 3.8, "target_wt_pct": 3.4 },
        { "sector": "Materials", "current_wt_pct": 2.2, "target_wt_pct": 3.0 },
        { "sector": "Utilities", "current_wt_pct": 4.0, "target_wt_pct": 2.2 },
        { "sector": "Real Estate", "current_wt_pct": 1.5, "target_wt_pct": 1.8 },
        { "sector": "Others", "current_wt_pct": 1.3, "target_wt_pct": 1.5 }
      ],

      "geographic_allocation": [
        { "region": "United States", "current_wt_pct": 67.5, "target_wt_pct": 57.5 },
        { "region": "Other", "current_wt_pct": 16.5, "target_wt_pct": 21.6 },
        { "region": "International Developed", "current_wt_pct": 10.3, "target_wt_pct": 20.8 },
        { "region": "Emerging Markets", "current_wt_pct": 5.6, "target_wt_pct": 0.0 }
      ],

      "holdings": [
        {
          "ticker": "TSM",
          "name": "Taiwan Semiconductor Manufacturing Co Ltd",
          "sector": "Information Technology",
          "region": "International Developed",
          "shares": 17,
          "market_value_usd": 6300,
          "current_wt_pct": 2.61,
          "target_wt_pct": 0.0,
          "weight_change_pct": -2.61,
          "unrealized_gain_usd": 1486,
          "unrealized_short_term_gain_usd": 1486,
          "unrealized_long_term_gain_usd": 0,
          "acquired_via": "ACAT_TRANSFER",
          "earliest_acquisition_date": "2025-11-02",
          "lots": [
            {
              "lot_id": "L-1001",
              "shares": 10,
              "cost_basis_usd": 3200,
              "market_value_usd": 3700,
              "acquisition_date": "2025-11-02",
              "term": "short",
              "acquired_via": "ACAT_TRANSFER"
            },
            {
              "lot_id": "L-1002",
              "shares": 7,
              "cost_basis_usd": 1614,
              "market_value_usd": 2600,
              "acquisition_date": "2025-12-15",
              "term": "short",
              "acquired_via": "ACAT_TRANSFER"
            }
          ],
          "planned_action": "sell",
          "planned_shares": 17,
          "planned_amount_usd": 6300
        },
        {
          "ticker": "WDC",
          "name": "Western Digital Corp",
          "sector": "Information Technology",
          "region": "United States",
          "shares": 16,
          "market_value_usd": 5875,
          "current_wt_pct": 2.44,
          "target_wt_pct": 0.0,
          "weight_change_pct": -2.44,
          "unrealized_gain_usd": 5249,
          "unrealized_short_term_gain_usd": 5249,
          "unrealized_long_term_gain_usd": 0,
          "acquired_via": "ACAT_TRANSFER",
          "earliest_acquisition_date": "2025-10-20",
          "lots": [
            {
              "lot_id": "L-1010",
              "shares": 16,
              "cost_basis_usd": 626,
              "market_value_usd": 5875,
              "acquisition_date": "2025-10-20",
              "term": "short",
              "acquired_via": "ACAT_TRANSFER"
            }
          ],
          "planned_action": "sell",
          "planned_shares": 16,
          "planned_amount_usd": 5875
        },
        {
          "ticker": "BNDX",
          "name": "Vanguard Total International Bond ETF",
          "sector": null,
          "region": "International Developed",
          "shares": 45,
          "market_value_usd": 2175,
          "current_wt_pct": 0.9,
          "target_wt_pct": 0.0,
          "weight_change_pct": -0.9,
          "unrealized_gain_usd": -41,
          "unrealized_short_term_gain_usd": -41,
          "unrealized_long_term_gain_usd": 0,
          "acquired_via": "PURCHASE",
          "earliest_acquisition_date": "2026-01-08",
          "lots": [
            {
              "lot_id": "L-2001",
              "shares": 45,
              "cost_basis_usd": 2216,
              "market_value_usd": 2175,
              "acquisition_date": "2026-01-08",
              "term": "short",
              "acquired_via": "PURCHASE"
            }
          ],
          "planned_action": "sell",
          "planned_shares": 45,
          "planned_amount_usd": 2175
        },
        {
          "ticker": "COF",
          "name": "Capital One Financial Corp",
          "sector": "Financials",
          "region": "United States",
          "shares": 0,
          "market_value_usd": 0,
          "current_wt_pct": 0.0,
          "target_wt_pct": 0.21,
          "weight_change_pct": 0.21,
          "unrealized_gain_usd": 0,
          "unrealized_short_term_gain_usd": 0,
          "unrealized_long_term_gain_usd": 0,
          "acquired_via": null,
          "earliest_acquisition_date": null,
          "lots": [],
          "planned_action": "buy",
          "planned_shares": 2,
          "planned_amount_usd": 502
        }
      ],

      "trade_summary": {
        "total_trades": 250,
        "buy_count": 101,
        "sell_count": 149,
        "buy_value_usd": 36190,
        "sell_value_usd": 37372,
        "transaction_cost_usd": null
      }
    }
  ]
}
```

> The `holdings` array above is **truncated to 4 representative rows** (a
> transfer-in sell with multiple lots, a single-lot sell, a bond ETF with
> `sector: null`, and a target-only buy). The real file carries all ~378
> holdings for the account.

---

## Field reference

### Envelope

| Field              | Type              | Notes                                         |
| ------------------ | ----------------- | --------------------------------------------- |
| `generated_at`     | string (ISO-8601) | staleness gate fallback                       |
| `firm_id`          | string \| number  | optional                                      |
| `transition_count` | int               | optional sanity check vs `transitions.length` |
| `transitions[]`    | array             | one object per account with a live plan       |

### Transition (per account)

| Field                     | Type          | Notes                                                |
| ------------------------- | ------------- | ---------------------------------------------------- |
| `account`                 | string (ULID) | **join key** → positions / household / cost basis    |
| `report_id`               | string        | traceability to the PDF; not a join key              |
| `account_title`           | string        | display only                                         |
| `strategy`                | string        | e.g. `"Direct Indexing"`                             |
| `status`                  | enum          | `active` \| `proposed` \| `completed` \| `cancelled` |
| `scenario`                | object        | the selected glide-path scenario (see below)         |
| `portfolio`               | object        | current-state rollups (total MV, unrealized ST/LT)   |
| `sector_allocation[]`     | array         | current vs target per sector                         |
| `geographic_allocation[]` | array         | current vs target per region                         |
| `holdings[]`              | array         | per-security detail incl. sector/region/lots         |
| `trade_summary`           | object        | recommended first-period trade rollup                |

### scenario

`name`, `selected` (bool), `gain_budget_usd`, `period_years`,
`rebalance_cadence` (`weekly`\|`monthly`\|`quarterly`\|`yearly`),
`tracking_error_vs_di_pct`, `tracking_error_vs_bm_pct` (nullable),
`capital_drift_pct`, `realized_pnl_usd`, `tax_estimate_usd`,
`realized_{short,long}_term_{gain,loss}_usd`,
`position_count_{current,target}`, `trade_count`.
If multiple scenarios were modeled, send them all with exactly one
`selected: true`.

### holdings[]

`ticker`, `name`, `sector` (nullable — bonds/cash), `region`, `shares`,
`market_value_usd`, `current_wt_pct`, `target_wt_pct`, `weight_change_pct`,
`unrealized_gain_usd`, `unrealized_{short,long}_term_gain_usd`,
`acquired_via` (`ACAT_TRANSFER`\|`PURCHASE`\|`DRIP`\|… nullable),
`earliest_acquisition_date`, `lots[]`, `planned_action`
(`buy`\|`sell`\|`hold`), `planned_shares`, `planned_amount_usd`.

### holdings[].lots[]

`lot_id`, `shares`, `cost_basis_usd`, `market_value_usd`, `acquisition_date`,
`term` (`short`\|`long`), `acquired_via`.

> **`lots[]` is the highest-value, optional-but-ideal field.** If Meridian
> can't emit lot detail, we reconstruct it live from Warehouse
> `apex_cost_basis_open_lot_refresh` joined on `account` + `ticker`. Sending it
> in the feed just lets the drift surface match the report exactly without a
> Warehouse round-trip. The `acquired_via: ACAT_TRANSFER` flag is what lets drift
> distinguish a tax-managed transfer-in from a true rebalancing failure.

## Minimum viable subset

If the full shape is too much for a first cut, the **must-haves** to unblock
Phase 1 (transition-aware status + sector drift) are:

- `account` (ULID), `status`, `scenario.{gain_budget_usd, period_years,
tracking_error_vs_di_pct, capital_drift_pct}`
- `sector_allocation[]` (current vs target)
- `holdings[]` with at least `{ticker, sector, region, current_wt_pct,
target_wt_pct}`

Everything else (lots, geographic, trade_summary) layers in afterward and/or
comes from Warehouse.
