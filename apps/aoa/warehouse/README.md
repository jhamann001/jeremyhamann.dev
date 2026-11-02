# Warehouse card mirror

The saved Warehouse questions that produce client-facing performance and funding
figures, mirrored here so the SQL is reviewable in version control and so an
unreviewed change to it is **detectable rather than silent**.

| Card | Name | Role |
|---|---|---|
| 6469 | AOA Daily Balances (TWR) | Daily market value and cash — `total_equity` is the MV each day's return is computed from |
| 6470 | AOA Activities (TWR) | Flows, dividends, fees, corporate actions (TRADE/ALLOCATION excluded by the category filter) |
| 6471 | AOA Cost Basis (TWR) | Open tax lots at the latest snapshot ≤ as-of |
| 6472 | AOA Account Number UULID Resolver | Account number → ULID, plus client identity |
| 6502 | AOA Realized G/L YTD | Closed tax lots, deduplicated **inside the card** |
| 6634 | New Funding (ACH/Check/Wire) - AOA v2 (Rebook-safe) | External funding with rebook lineages collapsed to one economic deposit |

## This is a mirror, not the source of truth

**Warehouse holds the executing copy. Editing a file here changes nothing.** The
application calls `POST /api/card/{id}/query/json`; it never reads these files.

That is a deliberate limitation rather than an oversight. Moving the SQL into the
application would mean the app composing queries instead of calling reviewed,
parameterised saved questions, which is a larger change with its own risks (§2 of
the methodology document explains why saved cards are used). What the mirror
provides is the two things that were actually missing: reviewability and
detection.

## Runtime application access policy

The deployed application may use Warehouse only to execute the reviewed saved
cards listed in `RUNTIME_WAREHOUSE_CARD_IDS` in `lib/warehouse/client.ts`. The
shared runtime client constructs the fixed `/api/card/{id}/query/json` endpoint
itself and accepts only template-tag parameters. It exposes no arbitrary path,
native SQL, metadata, collection, dashboard, or mutation operation; rejects
redirects; and refuses to send the key over non-HTTPS transport. Performance
card results are also checked against exact per-card column/type schemas before
the application uses any row.

Warehouse's saved-card read endpoint uses HTTP `POST`; that verb does not mean the
application writes to Warehouse. The semantic operation is execution of a saved
read-only question.

These application controls reduce what a defect or future caller can do, but
they do **not** change the credential's permissions at Warehouse. A scoped,
read-only service-account key and preventive collection permissions remain the
independent administrative controls. Instructions and comments alone are not a
security boundary.

## Why it exists

Every number in every client-facing performance report comes from this SQL. Before
this mirror it lived only in Warehouse — outside this repository, outside
pull-request review, and outside the change-control section of the compliance
methodology document. Someone with Warehouse write access could change the
arithmetic behind a client report and nothing in the application's audit trail
would show it. §9.14 of the methodology document recorded that as an unverifiable
item; this is the remedy.

## Commands

```bash
npm run warehouse:check     # verify live Warehouse matches the manifest
npm run warehouse:export    # rewrite the mirror from live Warehouse, then commit
```

Both need `WAREHOUSE_URL` and `WAREHOUSE_API_KEY` — the same secrets the app and the
account-AUM cron already use. Neither command prints the key, the URL, or response
bodies.

## What counts as drift

`cards.manifest.json` is the control. Its `sqlSha256` covers the **normalized SQL
only** — CRLF folded, per-line trailing whitespace stripped, one trailing newline —
so reformatting a mirror file cannot raise a false alarm, while any change to the
SQL itself does.

The check also compares:

- **name** — a renamed card breaks the human trail from document to card.
- **databaseId** — a card re-pointed at another database returns different numbers
  from identical SQL. This is the quietest possible way for a report to go wrong.
- **collectionId** — a moved card may fall outside the permissions the review
  assumed.
- **template tags** — a required parameter made optional, or a new required one
  added, changes results or breaks the call. The application supplies a fixed set.
- **archived** — an archived card fails the report outright.

## When the check fails

It means the SQL behind client-facing figures changed outside pull-request review.
Two legitimate outcomes:

1. **Unintended** — revert it in Warehouse. The mirror is the record of what was
   reviewed.
2. **Intended and reviewed** — run `npm run warehouse:export`, inspect the diff, and
   commit it. The commit is then the record of what changed and when.

Do not "fix" a failure by editing the hash by hand. The hash exists to make a
change require a decision.

## Known gaps

- **The mirror is a snapshot in time.** It proves the SQL matched at the moment the
  check last ran, not continuously. Frequency is set by the scheduled workflow.
- **A change reverted between two checks is invisible.** Detection is not the same
  as prevention. Preventing it means restricting Warehouse write access on
  collection 2047 (Operations) to the people who own report accuracy — which is a
  Warehouse permissions change, not something this repository can enforce.
- **The API key used for verification reported `can_write: true` on these cards
  when the mirror was captured (2026-07-29).** The application now restricts its
  own runtime surface to reviewed card reads, but the credential still holds more
  privilege than it needs. Replace it with a scoped, read-only key when the
  Warehouse administrative change is available.
