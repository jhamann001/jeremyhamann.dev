# Trade Request

Internal trade request workflow app for Cedar Ridge Wealth. Advisors submit structured trade requests; traders review, approve, run the asset location engine, and manage execution plans.

## Architecture

Monorepo with three workspaces:

| Workspace | Stack                                          | Purpose                                                             |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `shared/` | TypeScript                                     | Domain types and allocation tables shared by server and client      |
| `server/` | Express 5, PostgreSQL, Passport (Google OAuth) | REST API, auth, sessions, Warehouse integration, Slack notifications |
| `client/` | React 19, Vite 6, Tailwind 4                   | SPA with advisor form, trading queue, execution plan UI             |

In production the server serves the built client as static files. In development the Vite dev server proxies API calls to the Express backend.

## Prerequisites

- **Node.js** 22+
- **PostgreSQL** 15+
- **Google OAuth credentials** — create at [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
- **Warehouse** (optional for local dev) — when not configured, `/api/clients` serves seed data from the local DB

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp server/.env.example server/.env
# Edit server/.env — fill in Google OAuth credentials, session secret, and DB password at minimum

# 3. Create the database
createdb trade_request

# 4. Run migrations
npm run db:migrate

# 5. Seed sample data (optional — provides local client/account data when Warehouse is not configured)
npm run db:seed

# 6. Start development
npm run dev
```

This starts the API server on `http://localhost:8080` and the Vite dev server on `http://localhost:5173`.

## Environment Variables

Copy `server/.env.example` to `server/.env`. Key variables:

| Variable                                                                                             | Required             | Description                                                                                      |
| ---------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                                       | Yes (for migrations) | PostgreSQL connection string, e.g. `postgresql://postgres:changeme@127.0.0.1:5432/trade_request` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`                                            | Yes                  | Individual DB connection params used by the app at runtime                                       |
| `DB_SOCKET_PATH`                                                                                     | Cloud only           | Cloud SQL Auth Proxy socket path (overrides host/port)                                           |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                                                          | Yes                  | Google OAuth 2.0 credentials                                                                     |
| `GOOGLE_CALLBACK_URL`                                                                                | Yes                  | OAuth redirect URI (`http://localhost:8080/auth/google/callback` for local)                      |
| `SESSION_SECRET`                                                                                     | Yes                  | Random string for signing session cookies                                                        |
| `ALLOWED_EMAIL_DOMAIN`                                                                               | Yes                  | Only emails `@this-domain` can sign in                                                           |
| `WAREHOUSE_URL`, `WAREHOUSE_API_KEY`                                                                   | No                   | Warehouse instance for live client/account data                                                   |
| `WAREHOUSE_CONTACTS_QUESTION_ID`, `WAREHOUSE_INVESTMENTS_QUESTION_ID`, `WAREHOUSE_BALANCES_QUESTION_ID` | No                   | Warehouse saved question IDs                                                                      |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`                                                                | No                   | Slack notifications on status changes                                                            |

See `server/.env.example` for the full list with comments.

## Scripts

| Command                | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Start server + client in development mode                |
| `npm run build`        | Build all workspaces for production                      |
| `npm start`            | Start production server (requires `npm run build` first) |
| `npm run db:migrate`   | Run database migrations (`node-pg-migrate`)              |
| `npm run db:seed`      | Insert sample client/account data                        |
| `npm test`             | Run server + client tests                                |
| `npm run docker:build` | Build Docker image                                       |
| `npm run docker:run`   | Run Docker container with `server/.env`                  |

## Database Migrations

Migrations use [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) and live in `server/migrations/`. The `DATABASE_URL` env var is required.

```bash
# Run pending migrations
npm run db:migrate

# Roll back the last migration
npm run db:migrate:down

# Create a new migration
npm run db:migrate:create -- <migration-name>
```

## Docker

```bash
npm run docker:build
npm run docker:run
```

The image is a multi-stage Node 22 build. In the runtime stage only production dependencies and compiled output are included. The server serves the client SPA at the root and the API under `/api`.

### Container security and health checks

As of 2026-10-02, the distroless runtime explicitly runs as UID/GID `65532`
(non-root). Application files stay read-only to that user. Build and dependency
stages declare `HEALTHCHECK NONE` because they do not run the application.
The runtime health check uses Node's HTTP client in exec form to call
`/api/health/live`, respects `PORT`, and fails on a non-200 response, connection
error, or timeout. It requires neither a shell nor curl in the runtime image.
Cloud Run still uses the deployment workflow's configured probes; Docker health
checks support local/container execution. CI boots the actual production image
with placeholder auth settings and the isolated test database, verifies the
runtime UID/GID, and waits for the image's health check to pass.

## Dev environment (for Ops Portal DEV)

`trade-request-dev` is a non-production copy of the service that only Ops Portal DEV calls,
through the delegated surface (`/api/ops-portal`). It has its own Cloud SQL instance
(`trade-request-dev-db`) and runtime service account, holds synthetic seed data
only, and has no Slack, SMTP, Warehouse, AWS or scheduler configuration, so it
cannot notify traders or reach real client data. Its machine surface
(`/api/machine`) accepts only Ops Portal DEV's cutover job (its own service
account), for the cutover rehearsal. Standalone Google sign-in is not configured there.

- One-time setup: `scripts/setup-dev-env.sh`.
- Deploys: `.github/workflows/deploy-dev.yml` runs on every push to `main`;
  deploy a branch before merging with `gh workflow run deploy-dev.yml --ref <branch>`.
  The workflow fails if a forbidden setting, a non-dev secret, or any machine setting other than
  `MACHINE_AUDIENCE`, `ALLOWED_MACHINE_SA` and `SERVICE_MODE_CONTROLLER_SA` naming that job appears on the service.
- Live check with real Google signing:
  `node scripts/live-delegated-check.mjs <service-url> <ops-portal-runtime-sa> [--writes] [--wrong-caller=<sa>]`
  (needs a temporary token-creator grant on the accounts; `--writes` is refused
  against production).

## API Documentation

In development, Swagger UI is available at `http://localhost:8080/api/docs`.

## Monitoring & Alerting

The app emits structured JSON logs via [pino](https://github.com/pinojs/pino) that are automatically ingested by Cloud Logging on Cloud Run. To complete the observability setup, configure the following in GCP:

1. **Error rate alert** — Cloud Monitoring → Alerting → Create Policy. Metric: `logging.googleapis.com/log_entry_count` filtered by `severity >= ERROR` and `resource.type = "cloud_run_revision"`. Condition: count > 10 in a 5-minute window. Notification channel: Slack or email.
2. **Latency alert** — Metric: `run.googleapis.com/request_latencies` (p99). Condition: > 5000 ms over 5 minutes.
3. **Instance health** — Metric: `run.googleapis.com/container/instance_count` with a condition for zero instances (covers cold-start exhaustion).
4. **Uptime check** — Cloud Monitoring → Uptime Checks. URL: `https://<your-domain>/api/health`. Frequency: 1 minute. Alert on 2 consecutive failures.
5. **Log-based metric for 5xx responses** — Cloud Logging → Log-based Metrics. Filter: `resource.type="cloud_run_revision" AND httpRequest.status>=500`. Create an alert policy on the resulting metric.

For full APM and distributed tracing, add `@google-cloud/opentelemetry-cloud-trace-exporter` or deploy the OpenTelemetry Collector sidecar.

## Asset location modes

The asset location engine supports two allocation strategies, selectable per
trade request via the **Asset Location Mode** radio in the advisor form (and
persisted in `trade_requests.asset_location_mode`):

- **Priority (default)** — Tax-aware cross-account asset location using the
  internal priority matrix. Equity is preferred in Roth IRAs, fixed income in
  Traditional IRAs, etc. This is the legacy behavior and is the default for
  every new and existing request.
- **Mirror** — The household base allocation (cash/fixed/equity ratios derived
  from the risk profile) is applied proportionally to **each account**. Every
  sleeve ends up with the same allocation mix as the household, with no
  cross-account optimization. Use this when households reject asset location
  for compliance, transparency, or simplicity reasons.

Mirror mode reuses the same downstream verification, trade generation, and
Meridian registry pipelines as priority mode — see
`docs/plans/2026-q3-engine-mirror-mode.md` for the full design.

### Execution plans off (ticket)

`EXECUTION_PLAN_GENERATION=off` stops the service generating execution
plans: new Initial Funding and Rebalance requests save without a plan,
edits keep any stored plan, the trader run-engine action and its
holdings pre-fill reads answer 409, and non-MCP reads skip the stored-plan
verifier. Unset (or any other value) keeps today's behavior, which is the
production default; the dev service runs with it `off`. Production is
switched with
`gcloud run services update trade-request --region us-central1 --project example-project --update-env-vars EXECUTION_PLAN_GENERATION=off`
(a human runbook step). Once it is off, only the MCP `preview_engine` tool
and MCP reads still use the engine. Every engine use and refusal is counted
by caller class in `engine_use_daily` and served to OPS_PORTAL's cutover
controller at `GET /api/machine/engine-use?days=7`; its `coveredDays` counts
only complete days after the switch was observed off. A count write failure
logs `engine_use_count_failed`; a refusal whose count cannot be written
answers 503 instead of 409. See `BUILD_NOTES.md` for details.

## Trade-request householding

The advisor form ties new trade requests back to Meridian's firm-of-record
household map. When a selection lines up with one or more rows in
`active_accounts.json`, a sidecar appears next to the **Accounts** section and
prompts the advisor to either pull every sibling account into the request
("Include all"), pick a subset ("Choose…"), or dismiss the prompt. Sibling
selection is never automatic — the advisor always opts in.

At submit time the form persists `(household_id, household_name)` on
`trade_requests` **only if every selected ULID belongs to one and the same
household**; otherwise both columns stay `NULL`. Dismissing or acting on the
sidecar has no effect on persistence — only the final selected set does. The
tag is captured at POST time only; `PUT /requests/:id` cannot mutate it.

Edit/clone mode skips the resolver entirely so the household tag captured on
the original request flows through unchanged.

The resolver endpoint is `GET /api/households/resolve?clientIds=…&accountIds=…`,
backed by an in-process 30-minute cache over Meridian's `active_accounts.json`
export. When the export is unavailable (missing GCS object, parse error,
expired snapshot) the endpoint returns **HTTP 503** with
`error: 'household_data_unavailable'` and the client silently hides the
sidecar — submission is never blocked. See
`docs/plans/2026-q2-trade-request-householding.md` and the
"Trade request householding" section of `BUILD_NOTES.md` for the full design.

## Scheduled Jobs

### Daily Slack digest

Cloud Scheduler posts a queue summary to `SLACK_CHANNEL_ID` every weekday at **08:00 America/New_York** by calling `POST /api/internal/digest/daily`. The endpoint is OIDC-authenticated and idempotent per calendar date (tracked in the `digest_runs` table), so Scheduler retries and manual re-triggers the same morning are no-ops.

**Contents:** open-queue counts by status, urgent/overdue callouts, yesterday's submitted/completed/rejected totals, and a generic link back to the queue. On empty days the digest still posts an "All clear" message.

**Preview locally** (no Slack post, no DB write):

```bash
curl http://localhost:8080/api/internal/digest/preview
```

**One-time setup in GCP:**

```bash
# 1. Dedicated identity for Scheduler (principle of least privilege).
gcloud iam service-accounts create trade-request-scheduler \
  --display-name="Trade Request Scheduler"

# 2. Populate the two env vars on Cloud Run with the values you plan to use:
#    SCHEDULER_SERVICE_ACCOUNT_EMAIL — e.g. trade-request-scheduler@PROJECT_ID.iam.gserviceaccount.com
#    SCHEDULER_AUDIENCE              — your Cloud Run service URL (no trailing slash)
#    (These are set by .github/workflows/deploy-prod.yml, in the `env:` block at
#    the top and passed through its --update-env-vars string.)

# 3. Create the scheduled job.
gcloud scheduler jobs create http trade-request-daily-digest \
  --schedule="0 8 * * 1-5" \
  --time-zone="America/New_York" \
  --uri="https://<CLOUD_RUN_URL>/api/internal/digest/daily" \
  --http-method=POST \
  --oidc-service-account-email="trade-request-scheduler@<PROJECT_ID>.iam.gserviceaccount.com" \
  --oidc-token-audience="https://<CLOUD_RUN_URL>" \
  --attempt-deadline=120s \
  --max-retry-attempts=3
```

**Manually trigger in production** (e.g. to re-post after changing Slack channel):

```bash
gcloud scheduler jobs run trade-request-daily-digest
```

Note: manual runs on a day where the digest has already posted will return `{ sent: false, reason: 'already_posted' }` rather than double-posting. To force a re-post, delete the row for today from `digest_runs` and re-run the job.

**Change the channel:** update the `SLACK_CHANNEL_ID` secret in Secret Manager and redeploy (or wait for next cold start). No job changes required.

### Meridian template registry export (retired)

`GET /api/internal/meridian-registry` and its development preview were retired in ticket and return 404. The
weekday drift check compares positions with the Meridian templates (see "Registry drift detection" below) and reads
nothing from stored execution plans; its constants and result types live in `server/src/services/driftContract.ts`.

### Registry drift detection

Nightly job that builds the in-app Meridian registry, compares it to an externally uploaded Meridian templates snapshot from GCS, persists one row per household per local calendar day in `registry_drift_runs`, and posts a Slack alert to a dedicated drift channel when any non-allow-listed household exceeds the per-template tolerance (currently `DEFAULT_TOLERANCE_PCT = 5%`). The runner is invoked by Cloud Scheduler at **09:15 America/New_York** by calling `POST /api/internal/drift/check` with OIDC, idempotent per calendar date via a unique `(run_date_local, household_name)` constraint. Slot picked to land 15 min after the upstream Warehouse 09:00 ET refresh so the positions query reads the day's snapshot, not yesterday's.

**Routes** (all OIDC-protected with the existing `requireSchedulerAuth` middleware):

| Route                               | Verb | Purpose                                                                                                 |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| `/api/internal/drift/check`         | POST | Cloud Scheduler target. Builds registry → loads snapshot → compares → inserts rows → posts Slack.       |
| `/api/internal/drift/check/preview` | POST | Same pipeline without inserting rows or posting to Slack. Returns the comparison + metadata for review. |
| `/api/internal/drift/allow-list`    | GET  | Static allow-list of known-expected divergences (Whitaker, Ellis, Example, Moreno) with rationale.  |
| `/api/internal/drift/history`       | GET  | Newest-first per-household run history, `days` query param clamped to 1..90.                            |

**Environment variables:**

```
MERIDIAN_SNAPSHOT_SOURCE=gcs            # v1 supports `gcs` only
MERIDIAN_SNAPSHOT_BUCKET=meridian-templates-prod
DRIFT_ENABLED=false                       # merge gate; flip to `true` when bucket + snapshot are live
DRIFT_ALERTS_ENABLED=false                # runtime shadow-mode kill switch; flip after a clean shadow week
DRIFT_SLACK_CHANNEL_ID=C0123456789        # mounted from Secret Manager (`/secrets/DRIFT_SLACK_CHANNEL_ID`)
```

`DRIFT_ALERTS_ENABLED` is the runtime shadow-mode kill switch — when off, the job still runs and persists rows but every alert is suppressed with a `drift_alert_suppressed` info log. This lets a week of dry-run rows be reviewed before any operator sees a Slack message.

**Allow-list:** `server/src/services/registryDriftAllowList.ts` is the source of truth. Each entry pins a `householdName`, a `reason` (one of `awaiting_mirror_mode`, `awaiting_within_type_spread`, `awaiting_per_account_risk`), and the plan path that will eventually unblock the entry. Treat the allow-list as a "do not page" list, not a "do not detect" list — rows for allow-listed households are still persisted to `registry_drift_runs`; only the Slack alert is suppressed.

**Household configuration:** the runtime household source is the Meridian `active_accounts.json` export, loaded at every drift run from `gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/active_accounts/<YYYY-MM-DD>.json` by `server/src/services/meridianActiveAccounts.ts`. Each row carries the 26-char ULID (`trading_account_no`), the firm-baked `account_title`, and both `household_id` + `household_name`. Latest-by-filename selection mirrors the templates loader so both files stay in lockstep. The legacy `server/src/config/households.json` file and the `server/scripts/importHouseholds.mjs` regeneration script are retired in the 2026-Q3 Meridian-format cutover — see `BUILD_NOTES.md`. To refresh the runtime household source, upload the new Meridian export:

```bash
# Meridian sends `active_accounts_YYYYMMDD.json` + `templates_YYYYMMDD.json`.
# Upload both to GCS under the documented date-stamped paths:
gsutil cp ~/Downloads/active_accounts_YYYYMMDD.json \
  gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/active_accounts/YYYY-MM-DD.json
gsutil cp ~/Downloads/templates_YYYYMMDD.json \
  gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/templates/YYYY-MM-DD.json
```

The importer fails loud on duplicate account numbers or empty household names — fix them in the source CSV (or chase Apex) before re-running rather than working around them. `--skip-blank-name` is an explicit opt-in for the case where blank-name rows are known and tracked as upstream Apex follow-up; each skipped row emits a `WARN` line to stderr.

**Pre-flight provisioning (one-time, before flipping `DRIFT_ENABLED=true`):**

1. Create the secret: `printf 'C0123456789' | gcloud secrets create drift-slack-channel-id --data-file=- --replication-policy=automatic`.
2. Grant the runtime service account `roles/secretmanager.secretAccessor` on `drift-slack-channel-id`.
3. Create the bucket: `gsutil mb -l us-central1 gs://meridian-templates-prod`.
4. Grant the runtime service account `roles/storage.objectViewer` on the bucket.
5. Upload the initial Meridian exports to GCS:
   - `gs://meridian-templates-prod/meridian/active_accounts/<YYYY-MM-DD>.json`
   - `gs://meridian-templates-prod/meridian/templates/<YYYY-MM-DD>.json`
6. Verify both files are visible via `gsutil ls` BEFORE merging the cutover PR — the runner fails closed (503) if either is missing.

**Create the Cloud Scheduler job:**

```bash
gcloud scheduler jobs create http trade-request-drift-check \
  --schedule="0 2 * * *" \
  --time-zone="America/New_York" \
  --uri="https://<CLOUD_RUN_URL>/api/internal/drift/check" \
  --http-method=POST \
  --oidc-service-account-email="trade-request-scheduler@<PROJECT_ID>.iam.gserviceaccount.com" \
  --oidc-token-audience="https://<CLOUD_RUN_URL>" \
  --attempt-deadline=300s \
  --max-retry-attempts=3
```

**Runbook — alert was posted, what now:**

1. Open the Slack alert. Each line lists `householdName · max-delta · worst sleeve · account count`.
2. Cross-reference against the allow-list: `curl -H "Authorization: Bearer $TOKEN" https://<CLOUD_RUN_URL>/api/internal/drift/allow-list`. If the household is allow-listed, double-check the `unblocksWhenPlanShips` reference and silence; otherwise continue.
3. Pull the household's recent history: `curl ... /api/internal/drift/history?days=14 | jq '.runs | map(select(.householdName == "NAME"))'`. A first-time breach is most likely template drift; a multi-day breach is most likely a stale snapshot.
4. Verify both Meridian files are fresh: `gsutil ls -l gs://meridian-templates-prod/meridian/active_accounts/ | tail -3` and `gsutil ls -l gs://meridian-templates-prod/meridian/templates/ | tail -3`. The runner refuses files older than 35 days and returns 503; if no failure was seen, both files are fresh.
5. If the divergence is real, open a Linear bug under the Ops Apps team with the affected household, the breach delta, and the matching `details.accounts[]` from `registry_drift_runs`.

**Runbook — drift job returned 503:**

1. The 503 path is `SnapshotLoadError`. The structured log will contain `event: drift_run_aborted`, `reason: snapshot_load_failed`, `source: gcs`, and a `message` describing the failure (bucket missing, JSON parse error, stale snapshot, etc.).
2. Cloud Scheduler retries 3× per the policy above — if the underlying issue resolves (e.g. the upload completes), the next retry succeeds and persists a fresh row.
3. If retries exhaust, the day is missed. Recovery is to fix the upload and run `gcloud scheduler jobs run trade-request-drift-check` manually; the same-day insert is idempotent so a successful run completes cleanly.

**Force a re-post on the same day:** delete the relevant row(s) from `registry_drift_runs` (`DELETE FROM registry_drift_runs WHERE run_date_local = CURRENT_DATE AND household_name = '<NAME>';`) and re-run the job. The `ON CONFLICT DO NOTHING` guard guarantees only re-deleted rows generate fresh alerts.

#### Drift dashboard tab

The `Drift` tab in the Trade Center top navigation (path `/drift`) is a read-only history view of `registry_drift_runs` rows. It is **trader-only**, mirroring the existing `Users` tab pattern: advisors don't see the tab in the nav, and an advisor who types `/drift` directly into the URL bar gets the same inline "permission denied" UI as `/users` for non-traders. Defense in depth runs three deep: (1) the TopNav conditional spread hides the tab, (2) the `App.tsx` render gate substitutes the denial UI, (3) the `/api/drift` router calls `requireRole('trader')` so an authenticated advisor hitting any `/api/drift/*` route gets HTTP 403.

| Route                                              | Returns                                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/drift/history?days=N`                    | `{days, runs[]}` newest-first; `days` falls back to 30 for any non-finite, non-positive, or > 90 value (matches the internal route's ternary semantics). |
| `GET /api/drift/allow-list`                        | The static allow-list (same shape as `/api/internal/drift/allow-list`).                                                                                  |
| `GET /api/drift/runs/:runDateLocal/:householdName` | One-row drill-down with the JSONB `details` blob; 404 when the row does not exist.                                                                       |

**Filters:** segmented `7 / 30 / 90 days` control, "Breach only" checkbox, free-text household filter (300ms debounced). All three sync into the URL search params (`?days=`, `?breach=1`, `?q=`).

**Badges:** the `Breach` column distinguishes four states using a pure helper at `client/src/utils/driftBadge.ts` that mirrors `server/src/services/registryDriftAlert.ts:69-81` verbatim:

| Condition                                                         | Badge                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `coverage_status === 'unmapped_account'` (regardless of `breach`) | `Unmapped` (grey)                                                       |
| `!breach`                                                         | `Clean` (green)                                                         |
| `breach && allow-listed`                                          | `Allow-listed` (yellow, tooltip shows the entry's `reason` and `notes`) |
| `breach && !allow-listed && coverage !== 'unmapped_account'`      | `Would alert` (red — would fire today if `DRIFT_ALERTS_ENABLED=true`)   |

**Refresh:** manual only. Data updates exactly once per day at the scheduler's run; auto-refresh adds load with no signal benefit.

**Deferred for v2 / v3:**

- v2 — Manual "Re-run drift check" button gated behind a `rollout-drift-manual-rerun` LaunchDarkly flag (not yet shipped).
- v3 — Per-account, per-symbol delta drill-down (the JSONB `details` is fetched on row-expand but only `worstSymbol` + `accountCount` are surfaced today).
- v3 — CSV export of drift history.

### Drift v2 (per-account)

Replaces the household-level dashboard with a **per-account** view. Headline question per row: is this account inside or outside the 5pp tolerance, and which bucket (or symbol) is driving it? Persisted to a new `position_drift_accounts` table, written additively by the existing nightly runner on the same Cloud Scheduler tick.

The cron job `trade-request-drift-check` runs unchanged — the URL path `/api/internal/drift/check` is preserved and the runner now writes both v1 (`registry_drift_runs`) and v2 (`position_drift_accounts`) rows inside the same invocation. **Do not set up a second scheduler job.**

| Route                                  | Returns                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/drift/v2/history?days=N`     | `{days, runs[]}` newest-first per `(runDateLocal, accountId)`, sorted by `maxBucketDeltaPct DESC`. `days` clamps to `[1, 90]`, falls back to 30.                     |
| `GET /api/drift/v2/runs/:runDateLocal` | `{runDateLocal, runStartedAt, snapshotSource, snapshotAsOf, tolerancePct, uninvestedCashThresholdPct, accounts[]}` — full per-account payload incl. `details` JSONB. |
| `GET /api/drift/v2/allow-list`         | Same shape as v1 `/api/drift/allow-list`. Currently empty — kept for future per-account allow-list entries.                                                          |

All three routes are `requireRole('trader')` protected; advisor sessions get HTTP 403. The Slack alerter (`postAccountDriftAlert`) follows the v1 shadow-mode pattern: it formats per-account lines with the `…<accountId.slice(-6)>` suffix for unique account identification but **stays off until `DRIFT_ALERTS_ENABLED=true` is flipped**, so the v2 pipeline writes rows silently for a shadow-mode cycle before any operator sees a message.

**UI behaviour:**

- **Two views** with a pill toggle: `Accounts` (flat per-account table sorted by Δpp DESC, default) and `Households` (collapsible cards; cards auto-expand when any contained account is `out` or `uninvested`, collapsed otherwise).
- **Filters:** Status (`all` / `out` / `in` / `uninvested`), Worst bucket (`all` / `cash` / `fixed` / `equity`), Household (300ms-debounced free-text). All state mirrors to URL search params (`view`, `status`, `bucket`, `q`).
- **Drilldown:** click any row to expand into a per-bucket comparison table, a per-symbol breakdown for cash & fixed targets, and the equity holdings list. The bucket and symbol breakdowns share the same 5pp tolerance.
- **Status pills:** `In tolerance` (green), `Out of tolerance` (yellow), `Uninvested` (blue; ≥99% cash on a non-cash template).
- **`worstBucket = null`** (only possible when `totalValueUsd === 0`) renders as the em-dash glyph `—`, never `null`/`undefined`/empty.

**Coexistence + retirement:** the v1 routes (`/api/drift/history`, `/api/drift/runs/:date/:household`, `/api/drift/allow-list`), the v1 `DriftTab.tsx` component, the `registry_drift_runs` table, and the v1 Slack alerter all stay alive in this PR. After one clean shadow-mode cycle on the v2 pipeline, a follow-up retirement PR drops the v1 routes, the v1 dashboard, the v1 services (`positionDrift.ts`, `registryDrift.ts`, `registryDriftAlert.ts`, `meridianRegistry.ts`), and the `registry_drift_runs` table.

## Service mode (ticket)

The service has a persisted mode — `active`, `frozen` or `mcp-only` — and two standalone sender switches
(`digestSender`, `driftSender`, each `on` or `off`), stored in the single `service_mode` row. Every change is
appended to `service_mode_changes` with its time, caller and reason. The default is `active` with both
switches `on`, today's behavior.

- **Frozen:** every user-originated write — requests, checklists, status, exclusions, notification state, user
  administration, drift overrides, theme preference, and the same operations on `/api/ops-portal` — answers `423`
  with "Trade Requests is briefly read-only while it is being moved — try again in a few minutes." Reads,
  sign-in, Connected Apps, MCP and its OAuth sign-in keep working.
- **MCP-only:** everything except MCP, its OAuth sign-in and discovery documents, standalone sign-in, the
  Connected Apps APIs and the static client answers `403`; the web app shows only Connected Apps.
- **Frozen or MCP-only:** the digest and drift job routes return without posting or writing, and Slack and
  email sends do nothing. An `off` sender switch silences its job even while `active`.

OPS_PORTAL's cutover controller reads the state with `GET /api/machine/service-mode` and changes it with
`PUT /api/machine/service-mode` (`{ "mode"?, "digestSender"?, "driftSender"?, "reason" }`). Both need the
machine token; only the controller identity may change it: `SERVICE_MODE_CONTROLLER_SA` when set, otherwise
`OPS_PORTAL_DELEGATED_CALLER_SA`. The read reports `writesSettledAt`: a freeze refuses new writes at once, but a write
admitted just before it can still commit for up to 300 s (the Cloud Run request timeout), so the controller waits
until then before copying. On the dev service only Ops Portal DEV's cutover job may call them (`deploy-dev.yml`).

Emergency override: `SERVICE_MODE_OVERRIDE` (`active`, `frozen` or `mcp-only`; any other non-empty value reads as
`frozen`) wins over the persisted mode on every instance. Production:
`gcloud run services update trade-request --region us-central1 --project example-project --update-env-vars SERVICE_MODE_OVERRIDE=frozen`,
cleared with `--remove-env-vars SERVICE_MODE_OVERRIDE`; production deploys keep it unless the manual run's
`service_mode_override` input says otherwise. Dev: run `deploy-dev.yml` manually with `service_mode_override`
(dev deploys replace every variable, so a push deploy clears it).

## MCP server

The app exposes a read-only Model Context Protocol server at `POST /mcp` so advisors and traders can query the queue from Claude Desktop / Claude Code without opening the SPA. The server runs in-process alongside the Express API.

**Tools exposed** (all read-only, scoped per user — advisors see only their own requests, traders see all):

| Tool                  | What it returns                                               |
| --------------------- | ------------------------------------------------------------- |
| `get_request_counts`  | Counts by status                                              |
| `list_my_requests`    | Paginated list with optional free-text search                 |
| `get_request`         | Single request including audit trail                          |
| `get_last_allocation` | Most recent approved Initial Funding / Rebalance for a client |
| `get_queue_digest`    | Counts + recent open requests in one call                     |
| `preview_engine`      | Runs the asset location engine in preview mode (no DB writes) |

Writes (status changes, request creation, persisting an engine run) are deliberately **not** exposed — they stay in the SPA where the audit-trail and approval semantics live.

### Auth — OAuth 2.1 with Google as upstream IdP

Per the MCP spec, the server is both Authorization Server and Resource Server. It uses Google as the upstream identity provider (the same Google client used for SPA login) and issues its own audience-bound access tokens. RFC 7591 Dynamic Client Registration is supported, so MCP clients self-register on first connect. The same `ALLOWED_EMAIL_DOMAIN` gate applies — only `@example.com` / `@example.org` accounts can mint a token.

Endpoints exposed at the application root:

```
GET  /.well-known/oauth-authorization-server
GET  /.well-known/oauth-protected-resource
POST /register
GET  /authorize          → redirects to Google
POST /token              → access (1h) + refresh (30d), refresh rotates on use
POST /revoke
GET  /oauth/google/callback   → upstream Google callback (separate from /auth/google/callback used by the SPA)
```

Refresh tokens rotate on every use. If a rotated refresh token is replayed, the entire token family for that (user, client) is revoked — defense against stolen refresh tokens.

### Configuration

Set these env vars to enable the MCP server (it's disabled if any are missing):

| Variable                  | Example                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MCP_RESOURCE_URL`        | `https://<host>/mcp` (used as the audience in issued tokens; must match exactly what clients pass as `resource`) |
| `MCP_ISSUER_URL`          | `https://<host>` (the AS issuer; typically the server's origin)                                                  |
| `MCP_GOOGLE_CALLBACK_URL` | `https://<host>/oauth/google/callback`                                                                           |
| `MCP_GOOGLE_HD`           | `example.com` (optional `hd` hint to limit Google's account picker)                                      |

In Google Cloud Console, add `https://<host>/oauth/google/callback` to the OAuth client's authorized redirect URIs (alongside the existing `/auth/google/callback`).

### Record source (ticket)

MCP reads Trade Request records (requests, audit trails, last allocations, accounts and standing exclusions) from the local database unless `OPS_PORTAL_RECORDS_DB_HOST` is set. When it is set, every MCP tool call first reads Ops Portal's serving state through the read-only `trade_request_mcp_ro` login: while Ops Portal reports standalone-served the call reads locally; while OPS-PORTAL-served it reads OPS_PORTAL's `trade_request` schema and refuses a caller whose current Ops Portal role grants no Trade Request access. If Ops Portal cannot be read the call is refused with an unavailable message; it never falls back to local records. MCP sign-in, OAuth and token tables always stay local.

| Variable                  | Meaning                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `OPS_PORTAL_RECORDS_DB_HOST`     | Private Service Connect address of OPS_PORTAL's Cloud SQL instance; unset keeps MCP on local records     |
| `OPS_PORTAL_RECORDS_DB_PORT`     | Default `5432`                                                                                    |
| `OPS_PORTAL_RECORDS_DB_NAME`     | Default `opsPortal`                                                                                     |
| `OPS_PORTAL_RECORDS_DB_USER`     | Default `trade_request_mcp_ro`                                                                    |
| `OPS_PORTAL_RECORDS_DB_PASSWORD` | Secret mount `/secrets/OPS_PORTAL_RECORDS_DB_PASSWORD/secret` (OPS_PORTAL's `trade-request-mcp-ro-db-password`) |
| `OPS_PORTAL_RECORDS_DB_SSL`      | `verify-ca` (default; required in production) or `off` (local only)                               |
| `OPS_PORTAL_RECORDS_DB_SSL_CA`   | Secret mount with OPS_PORTAL's Cloud SQL server CA certificate                                           |
| `OPS_PORTAL_RECORDS_DB_POOL_MAX` | Default `2`, capped at 3 per instance (OPS_PORTAL's connection budget)                                   |

Production takes these from the repository variables `OPS_PORTAL_RECORDS_DB_HOST`, `OPS_PORTAL_PSC_NETWORK` and `OPS_PORTAL_PSC_SUBNET` (see `scripts/ops-portal-records-deploy-flags.sh`); `scripts/setup-ops-portal-records-endpoint.sh` creates the endpoint and prints the values. The dev service has no MCP and never sets them. `scripts/setup-ops-portal-copy-login.sh` creates the separate `trade_request_ops_portal_copy` login OPS_PORTAL's copy engine uses on this database (`server/sql/create-ops-portal-copy-role.sql`).

### Connecting from Claude Code

```bash
claude mcp add --transport http trade-request https://<host>/mcp
```

Claude will walk you through the OAuth flow on first use — a browser window opens, you sign in with Google, and the token is stored locally. Once connected, you can ask things like _"what's in my queue?"_ or _"show me the last allocation we ran for the Smiths"_ and the relevant tool fires.

### Connecting from Claude Desktop (or other clients without OAuth)

Claude Desktop doesn't yet expose Custom Connectors on every plan, and other MCP clients may not speak OAuth at all. For those, generate a Personal Access Token (PAT) from the SPA's **Connected Apps → API tokens** tab, then paste it into the client's config:

```json
"trade-request": {
  "type": "http",
  "url": "https://<host>/mcp",
  "headers": { "Authorization": "Bearer tr_pat_..." }
}
```

PATs are long-lived and don't expire on their own — revoke them from the same Connected Apps tab when a device is lost or no longer needs access. The cleartext token is shown exactly once at generation time and is never returned again; the server stores only a SHA-256 hash. Deactivating a user cascades a revoke across both their PATs and any active OAuth sessions.

### Storage

OAuth state lives in five tables created by the `20260427000000_oauth-mcp.sql` migration: `oauth_clients`, `mcp_pending_auth`, `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`. PATs live in `mcp_pats` (`20260428000000_mcp-pats.sql`). All tokens are stored as SHA-256 hashes (32-byte `BYTEA` columns); the cleartext value is only ever in the response body of `/token` (OAuth) or `POST /api/me/mcp-tokens` (PAT).

## Project Structure

```
├── shared/
│   └── src/
│       ├── types.ts          # Domain types (Client, Account, TradeRequest, etc.)
│       └── allocations.ts    # Risk profile → base allocation lookup table
├── server/
│   ├── migrations/            # node-pg-migrate SQL migrations
│   ├── src/
│   │   ├── db/                # Pool config, seed runner
│   │   ├── docs/              # OpenAPI/Swagger spec
│   │   ├── lib/               # Logger
│   │   ├── middleware/        # Auth (Passport + Google OAuth), error handler
│   │   ├── routes/            # /auth, /api/clients, /api/requests, /api/users
│   │   ├── services/          # Warehouse client, asset location engine, Slack, request queries
│   │   └── mcp/               # MCP server: tools, OAuth 2.1 AS+RS, Google upstream callback
│   └── .env.example
├── client/
│   └── src/
│       ├── api/               # Axios HTTP client
│       ├── components/        # React components (AdvisorForm, TradingQueue, etc.)
│       ├── contexts/          # AuthContext, ThemeContext
│       ├── hooks/             # useTradeRequests, useNotifications
│       └── utils/             # Formatting, allocation helpers
├── Dockerfile
└── package.json               # Workspace root
```
