# Transfer Tracker

Internal tool for Cedar Ridge Wealth to track, reconcile, and manage ACAT (Automated Customer Account Transfer) requests across custodians.

## Architecture

```
Next.js 16 (App Router) + React 19
├── Auth: NextAuth v5 + Google OAuth (domain-restricted)
├── Database: PostgreSQL via Prisma ORM
├── Validation: Zod schemas on all API inputs
├── Logging: Pino (structured JSON)
├── Fees: Fee Store Database API (external)
└── Deployment: Docker + GCP
```

### API Routes

| Route | Methods | Description |
|---|---|---|
| `/api/acats` | GET, POST | List/create ACAT records |
| `/api/acats/[id]` | GET, PATCH, DELETE | Single record CRUD (soft-delete) |
| `/api/custodians` | GET | List custodians |
| `/api/asset-mapping` | GET, POST | Asset reconciliation data; POST syncs from GCP |
| `/api/fees` | GET, POST | Fee reimbursements (Fee Store proxy) |
| `/api/health` | GET | Public liveness probe (returns `{ ok: true }`) |
| `/api/health/detailed` | GET | Admin-only: DB status, uptime, version |

## Prerequisites

- Node.js 20+
- Docker & Docker Compose (for local Postgres)
- Google Cloud OAuth credentials

## Local Development

### 1. Clone and install

```bash
git clone <repo-url>
cd transfer-tracker
npm install
```

### 2. Set up environment

```bash
cp .env.example .env
```

Edit `.env` with your values (see [Environment Variables](#environment-variables) below).

### 3. Start the database

```bash
docker compose up postgres -d
```

### 4. Run migrations and seed

```bash
npm run db:push
npm run db:seed
```

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Running with Docker Compose (full stack)

```bash
docker compose up --build
```

This starts both Postgres and the Next.js app.

## Testing

```bash
npm test            # Run all tests once
npm run test:watch  # Watch mode
```

Tests use Vitest with `@testing-library/react` for components and mocked Prisma for API routes.

## Database

### Prisma commands

```bash
npm run db:generate  # Regenerate Prisma client
npm run db:migrate   # Create and apply migrations
npm run db:push      # Push schema to DB (dev only)
npm run db:seed      # Seed with sample data
npm run db:studio    # Open Prisma Studio GUI
```

### Schema overview

- **AcatRecord** — 30+ fields covering core info, accounts, dates, fees, and audit
- **Asset** — Securities tied to each ACAT record
- **Custodian** — Delivering/receiving firms
- **AuditLog** — Every field-level change is logged

## Authentication

Google OAuth with NextAuth v5. Sign-in is restricted to:

- `@example.com`
- `@example.org`

All routes except `/login`, `/api/auth/*`, and `/api/health` require authentication. Auth is enforced globally via Next.js Proxy — any non-public route returns 401 (API) or redirects to `/login` (pages) for unauthenticated requests.

## GCP Asset Mapping Integration

The Security Recon tab integrates with the **statement-pipeline** GCP project to sync expected positions. When configured:

1. `GET /api/asset-mapping?acatId=...` returns the current DB state (assets, mapping source, last sync time)
2. `POST /api/asset-mapping` triggers a sync from the GCP service, upserting `Asset` records in the DB

Set `GCP_ASSET_MAPPING_URL` in your environment to enable the sync. Without it, the POST endpoint returns 503 and the UI falls back to showing DB-only data.

### Transfer context in Security Recon

GCP sync also imports three read-only columns into Position Details:

- **Transfer eligibility:** `effective_status` and `effective_notes` (including
  upstream overrides; engine values are the fallback when effective values are absent).
- **Transferring?:** the pipeline's `transferring` selection, preserving Yes, No,
  and unset separately. This is independent of `includeInTransfer`, which controls
  partial-transfer paperwork, and does not change reconciliation outcomes.
- **Statement freshness:** `statement_date`, `statement_age_days`, and `is_stale`,
  saved with each imported position. Age and stale flags are source-reported values
  and may reflect the original processing date; the tracker does not recalculate them.

These fields refresh on each successful GCP sync, including clearing previous values
when the source clears them. Local reconciliation notes and statuses are preserved.
Positions absent from a later response retain their own prior statement snapshot.
Spreadsheet imports preserve previously synced GCP context. CSV reconciliation exports
include the new context, while Apex-only positions have no imported context.

`Last GCP sync` uses a persisted timestamp. Existing records show no recorded timestamp
or context until their next successful sync. Apply migration
`20260915160000_add_asset_mapping_context` before deploying this version.

## Deployment (GCP + Docker)

### Build the image

The image builds from the repository root, where the npm workspaces and the lockfile live:

```bash
docker build -f apps/acat/Dockerfile --platform linux/amd64 -t transfer-tracker .
```

### Push to Artifact Registry

```bash
docker tag transfer-tracker us-central1-docker.pkg.dev/<PROJECT>/transfer-tracker/app:latest
docker push us-central1-docker.pkg.dev/<PROJECT>/transfer-tracker/app:latest
```

### Required GCP setup

1. Cloud SQL (PostgreSQL 16) or equivalent
2. Cloud Run or GKE for the container
3. Set all environment variables in the runtime config
4. Configure OAuth redirect URIs to match `NEXTAUTH_URL`

### The public demo (transfers.jeremyhamann.dev)

- `worker/` is a Cloudflare Worker in front of one container built from `Dockerfile`. It limits each
  visitor at the edge, forwards the visitor's IP in `X-Forwarded-For`, returns 404 for the reset,
  scheduler, machine and MCP endpoints, keeps search engines out, and calls the reset every night at
  07:00 UTC.
- `demo-config.json` holds the demo's settings (no secrets). The Worker adds the database address, the
  auth secret and the reset token, plus fresh keys for the loopback stand-ins on each start.
- `.github/workflows/deploy-acat.yml` deploys it when run by hand on `main`: tests, migrations over the
  direct host, `DEMO_SEED=reset npm run demo:reset`, then `wrangler deploy`.
- Caps on what visitors can add hold until the nightly reset (`src/lib/demo/limits.ts`).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Yes | Random secret for session encryption (`openssl rand -base64 32`) |
| `NEXTAUTH_URL` | Yes | Full URL where the app is hosted |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `FEE_STORE_API_KEY` | For fees | Fee Store Database API key |
| `FEE_STORE_DB_URL` | For fees | Fee Store DB base URL |
| `FEE_STORE_FEES_TABLE_ID` | For fees | Fee Store fees table ID |
| `GCP_ASSET_MAPPING_URL` | For recon | Base URL for statement-pipeline GCP service |
| `LOG_LEVEL` | No | Pino log level (default: `info` in prod, `debug` in dev) |

## CI/CD

GitHub Actions is the source of truth for deploys. Cloud Build is no longer
in the loop — see `docs/cicd-runbook.md` for the full operator guide.

### Workflows

- `.github/workflows/ci.yml` — lint + test + build + npm audit + actionlint +
  shellcheck + structural script tests + migration-safety check. Runs on every
  PR and push to `main`. Does NOT deploy.
- `.github/workflows/codeql.yml` — security static analysis on PR / push /
  weekly cron.
- `.github/workflows/deploy.yml` — production deploy of the main app on push
  to `main`. Build → scan-gate → migrate → deploy → smoke. Gated on the
  `production` GitHub Environment (manual reviewer approval).
- `.github/workflows/deploy-mcp.yml` — production deploy of the MCP service.
  Same gate as `deploy.yml`. Path-filtered on `src/mcp/**` and friends.
- `.github/workflows/rollback.yml` — manual `workflow_dispatch` to shift 100%
  of traffic to a chosen prior Cloud Run revision (for either service).

### Branching strategy

Trunk-based. Feature branches PR into `main`, squash-merged. No long-lived
`develop`. Hotfixes use the same PR + approval-gate path; for genuine
emergencies, run `rollback.yml` first to restore the previous good revision,
then open a forward-fix PR through the normal flow.

### Forward-only migration constraint

`prisma migrate deploy` is forward-only. Rollback restores Cloud Run
revisions but does NOT restore database schema. Destructive migrations
(DROP COLUMN, RENAME COLUMN, etc.) require a two-phase release pattern;
the PR template's "Schema change checklist" and `check-migration-safety.sh`
CI gate enforce this at PR time.
