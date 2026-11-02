# Always-On Advice

Always-On Advice (AOA) is Cedar Ridge Wealth's authenticated operating system for
advisors, client service, and operations. This repository contains the real
Next.js application, database migrations, cloud infrastructure, deployment
workflows, source integrations, operational runbooks, and security controls.

The frozen visual prototype and early planning material live in
[`cedar-ridge-wealth/aoa-mockup`](https://github.com/cedar-ridge-wealth/aoa-mockup).
This repository is the deployable application and the source of truth for its
behavior.

## Environments

| Environment | Branch / trigger | GCP project and service | Data | Authentication |
|---|---|---|---|---|
| **Local** | Any working branch | Developer machine + Docker Postgres | Repository-defined synthetic seed only | Built-in persona login |
| **Development** | Successful CI on `dev`, followed by owner approval | `ops-portal-dev` / `aoa-dev` | Approved non-production representative records in an isolated development database; explicitly labeled previews may use deterministic synthetic fixtures | Environment-specific Okta OIDC, with owner-controlled persona access available for approved testing |
| **Production** | Merge of the reviewed `dev` promotion PR to `main`, followed by owner approval | `ops-portal` / `aoa` | Production data mirrored from approved source systems | Okta OIDC with database-backed sessions |

The canonical cloud development service is
[`aoa-dev` in `ops-portal-dev`](https://helpdesk.example.com).
The production service is
[`aoa` in `ops-portal`](https://helpdesk.example.com).
Any similarly named service inside the production project is outside the
supported development deployment path and must not be treated as the canonical
dev environment.

There is no separate staging tier. Local development is the first check; the
isolated cloud dev environment is the production-like integration rehearsal.
Dev and prod have separate projects, databases, registries, identities, secrets,
Terraform state, and protected GitHub Environments. Development is governed as
sensitive even though its records and available source history differ from
production; it never connects to the production database.
The durable match/difference contract and remaining gates are tracked in
[`docs/operations/dev-production-parity.md`](docs/operations/dev-production-parity.md).

The reviewed legacy-development import, canonical-dev validation, fixture
cleanup, temporary-resource cleanup, and legacy retirement are complete. The
development feeds target only canonical dev, and deal-sourced transfer cards
are materialized there. Normal deployments never seed canonical dev; synthetic
reseeding is a separate manual, owner-approved recovery action. The detailed
evidence and recovery controls remain in the
[dev/prod parity contract](docs/operations/dev-production-parity.md),
[legacy migration runbook](docs/operations/legacy-dev-data-migration.md), and
[dev fixture-cleanup runbook](docs/operations/dev-demo-data-cleanup.md).

## Current product status

As of 2026-09-01, the functionality below is deployed to production. This list
describes the current application rather than the frozen mockup, old phase
labels, or a future-product backlog.

### Live application surfaces

- **Households and Client Portrait:** Fast, RLS-scoped directories and detail
  pages for client and household records, accounts, AUM, deals, tasks, email and
  activity context, reminders, funding, CRM relationships, and source links.
  Household filtering covers advisor, household status, and client/lost-client
  views; employee and former-employee badges remain visible on matched records.
  Household account filtering includes open, closed, and all accounts. Closed
  accounts retain a zero balance and the best available source closed date; Apex
  balances are separated into cash, securities, and total. The display-only
  custodial seam also supports confirmed Schwab balances, masked account
  numbers, source dates, and penny-precise account tables. Performance, forms,
  trading, and external-funding paths remain Apex-only.
  - **Schwab rollout:** Code support does not mean the live feed is active.
    Reviewed mappings must be applied by an approved live snapshot before
    balances appear. Firm operating funds are always excluded from the directory
    AUM KPI. The employee toggle uses confirmed employee contacts; a nonzero
    household-only Schwab account withholds the employee-excluded total until
    its ownership is resolved. See the [display and release plan](docs/planning/schwab-account-display-aum.md).
- **Zendesk support history:** Read-only linked tickets appear on authorized
  client and household pages. Each ticket can be expanded to show its initial
  request and public comments while preserving a direct Zendesk link. Private
  notes and attachments are excluded, Zendesk remains authoritative, and the
  mirror is refreshed by the approved scheduled n8n workflow.
- **Client Portrait · Core Financial:** Confirmed custodial accounts, trailing-12-month external
  cash funding, an app-owned annual tax budget, approved investment instructions
  and risk profile, linked Trade Requests, and the existing performance-report
  entry points.
  - External funding includes ACH, check, and wire deposits and collapses Apex
    rebook lineages to one economic deposit without collapsing legitimate
    same-day, same-amount transactions.
  - Authorized users manually maintain the tax budget and realized YTD amount;
    the inputs accept arbitrary non-negative currency amounts rather than only
    rounded thousands or millions.
  - Investment instructions and risk are derived only from approved or completed
    allocation requests (Initial Funding or Rebalance) and matched at the
    Apex-account level; cash-only requests are excluded. When multiple qualifying
    requests exist, the portrait calls for human review instead of silently
    choosing between conflicting instructions.
  - A confirmed Trade Request becomes the authoritative source for that account,
    records reviewer provenance, and collapses out of the way. A newer approved
    request or an unavailable/stale selection automatically reopens review.
- **CRM Explorer and Relationships:** Operations/Admin users can inspect
  canonical identities, aliases, exact source relationships, and a searchable
  household relationship map. Continuous reconciliation detects household and
  contact duplicate candidates; users can compare exact CRM IDs, manually
  flag a pair, confirm the record AOA should preserve, reject a false positive,
  or snooze review. Confirmed duplicates are reversibly canonicalized inside AOA
  operating views. AOA does not merge, delete, or update the underlying CRM
  records, and the detector never performs an automatic merge.
- **Reporting:** Operations/Admin users have read-only Households & AUM, Deal
  pipeline, Client engagement, and Transfers & funding reports. The compact
  filter bar, active-filter summary, reset behavior, sorting, pagination, and
  selectable columns remain synchronized with URL state. Four pinned operating
  views are included; users can also save browser-local named views or copy a
  permission-scoped filtered link. Reporting does not mutate or export source
  data and does not add new performance metrics.
- **Employee roster:** Admin/Operations can validate and apply complete,
  effective-dated Rippling `.xlsx` snapshots from CRM Explorer, explicitly
  confirm or reject suggested CRM contact matches, and surface RLS-scoped
  active/former employee badges. A quarterly reminder identifies when a newer
  roster should be reviewed. Raw workbooks and dependent names are not retained;
  exact names never auto-confirm. See
  [employee roster operations](docs/operations/employee-roster.md).
- **Operational workflows:** Command Center, Deals, the app-owned Asset Transfer
  lifecycle, ACAT tracking, CRM-linked tasks, global search, and the
  append-only audit log. Asset Mapping and Trade Requests remain authoritative
  standalone applications reached through external links.
- **Data Health:** A compact Operations/Admin status list reports freshness,
  availability, and durable run evidence for Account AUM, CRM reconciliation,
  Trade Requests, external cash funding, and Zendesk. Details remain expandable,
  and missing evidence stays unknown rather than being inferred from client data.
- **Existing performance reports:** The protected account- and household-level
  routes remain in place, but launch controls are hidden pending accuracy
  revalidation. These reports are not approved for client use.

### Intentionally limited or deferred

- **Dual View and Illustration** are implemented as deterministic, synthetic-data
  prototypes in canonical dev. Production continues to show the Phase E / Phase
  D placeholders until their live signal, calculation, disclosure, and delivery
  contracts are approved.
- **Documents and Egnyte** remain paused. AOA does not store document bytes, and
  the tab is not connected to a client or vault. Egnyte remains the intended
  system of record; embedding and CRM-ID tagging wait on approved access and an
  integration permissions model.
- **Decision Center, Tasks, and Smart Nudges** include prototype workflow
  surfaces, but the proposed household-wide decision experience remains in the
  mockup pending stakeholder review. Do not treat its in-memory preview behavior
  as a production decision record.
- **example.org lifecycle modeling** for users, registrants, and future clients
  is paused until the authoritative product lifecycle and identity boundaries are
  confirmed.
- **Performance continuity across successor accounts** is not spliced into one
  account report. Companion and successor brokerage accounts retain their own
  histories; the corrected journal treatment prevents a transfer day from
  creating a false investment return, while a future reviewed enhancement may
  present continuous predecessor/successor performance.
- Canonical dev does not carry every production client or the complete custodial
  history required for all performance reports. Use dev to validate application
  behavior and integrations; production report verification remains a controlled,
  authorized check against production source history.

## Owner-controlled delivery

the owner is the required reviewer for both development and production
deployments. Automation can build, test, migrate, deploy after approval, verify,
and roll back traffic; it cannot approve a deployment, promote `dev` to `main`,
or apply Terraform.

The delivery path is:

1. Branch from `dev` and open a pull request back to `dev`.
2. CI runs the production dependency audit, typecheck, lint, unit/integration
   tests, application build, seed-image build, PostgreSQL integration suite, and
   an authenticated production-mode browser test over the critical Households,
   Client Portrait, Reporting, and Data Health routes. That test uses only an
   ephemeral PostgreSQL service and repository-defined synthetic records.
3. After review, merge to `dev`.
4. A successful `dev` CI run is classified before any environment approval.
   Documentation-only changes stop there without a deployment.
5. A runtime-affecting change enters the protected `dev` deployment gate and
   waits for the owner's approval.
6. The dev workflow builds commit-addressed app and migration images, runs
   migrations, deploys `aoa-dev`, and requires API, deployed-browser, and
   database-stability checks. It never seeds canonical dev. A failed post-deploy
   smoke check restores traffic to the prior revision.
7. Synthetic reseeding is a separate manual workflow restricted to `dev`, an
   exact confirmation phrase, and the owner's protected-environment approval.
8. Review the change in the canonical dev service.
9. Open a promotion pull request from `dev` to `main`. Feature pull requests
   aimed at `main` are automatically retargeted to `dev`, and CI rejects any
   production PR whose source branch is not `dev`.
10. After the promotion PR is reviewed and merged, the production workflow waits
   at the protected `prod` approval gate.
11. Once the owner approves, production migrations run before the new revision
   receives traffic. The workflow then deploys, checks `/api/health`, and rolls
   traffic back if the post-deploy health check fails.

Database migrations are forward-only during deployment. Application traffic can
be rolled back to a prior revision, but migrations are never automatically
reversed; a database problem is handled with a reviewed forward-fix or the
applicable recovery runbook.

## What the application includes

Implemented product areas include:

- Command Center, including the deal funnel, meetings, signals, stalled work,
  and optional AI-generated meeting preparation.
- RLS-scoped household and client views with accounts, activity, CRM tasks,
  Zendesk tickets and public comments, emails, reminders, deals, funding context,
  CRM identity links, and confirmed relationship context.
- Deals pipeline and the app-owned asset-transfer lifecycle, including
  checklists, account/position decisions, funding state, and closeout workflow.
- In-app ACAT tracking, with links to the standalone Asset Mapping and Trade
  Request applications where those systems remain authoritative.
- Client Portrait Core Financial workflows for external funding, manual tax
  budgets, and reviewed account-level Trade Request instructions and risk.
- CRM Explorer duplicate detection, reviewed AOA canonicalization, manual
  household/contact comparison, and a read-only searchable relationship map.
- Read-only operational reporting with persistent URL filters, pinned reports,
  browser-local saved views, and copyable permission-scoped links.
- Compact source Data Health monitoring with durable run evidence and source
  business dates where each upstream system publishes them.
- Existing audited performance reports backed by reviewed Warehouse saved
  questions and a market risk-free-rate feed; enhancement work is paused.
- Prototype Decision Center, Tasks, and Smart Nudges surfaces, plus global search
  and the operations audit log.
- Admin/Operations employee-roster uploads with reviewed CRM contact
  matching and book-scoped active/former badges.
- Bearer-protected ingest endpoints and scheduled pull/sync endpoints for the
  approved mirror feeds and integrations.

Some integrations and UI paths are deliberately controlled by server-side
feature flags. They are off unless their environment variable is exactly `1`;
local configuration and safe defaults are documented in
[`.env.example`](.env.example), while deployment-owned activation is defined in
the reviewed workflow and Terraform configuration.

## Architecture

- **Web application:** Next.js 15 App Router, React 19, and TypeScript.
- **Runtime:** Standalone, non-root Node.js 20 container on Cloud Run.
- **Authentication:** Auth.js v5. Local development uses seeded personas.
  Canonical cloud development and production use separate Okta OIDC
  applications with database-backed sessions. `AUTH_DEV_LOGIN=1` is reserved
  for an explicitly reviewed temporary cutover or recovery action and is never
  enabled in production.
- **Authorization:** Okta groups map to application roles. PostgreSQL
  Row-Level Security enforces book-of-business scope at the data layer, with
  additional server-side role checks for sensitive operations.
- **Database:** PostgreSQL 16. Prisma manages the `app` and `audit` schemas;
  hand-authored SQL migrations manage the read-only `mirror` schema, roles,
  grants, RLS policies, and database controls.
- **Data separation:** Source-system copies live in `mirror`; AOA-owned workflow
  state lives in `app`; audit records live in `audit`. Ingestion cannot write to
  app-owned workflow tables.
- **Ingestion and integrations:** n8n and other approved machine callers use
  authenticated application endpoints. AOA also reads from Warehouse, the ACAT
  pipeline, the Trade Request app, Zendesk's public ticket history, Slack/n8n
  closeout workflows, Treasury data, and Vertex AI where configured.
- **Performance-report control:** The executing saved questions remain in
  Warehouse, while their SQL and metadata are mirrored under `warehouse/`.
  Scheduled drift detection reports an out-of-band Warehouse change.
- **Cloud:** Separate Terraform stacks provision dev and prod Cloud Run, private
  Cloud SQL, Direct VPC egress, Artifact Registry, Secret Manager, IAM,
  Workload Identity Federation, encryption, and monitoring controls.
- **CI/CD:** GitHub Actions uses keyless Workload Identity Federation and
  protected GitHub Environments. Infrastructure automation validates Terraform
  but never plans or applies it automatically. CI exercises authenticated
  critical application routes with synthetic data before a reviewed commit can
  progress through the protected deployment path.

The database identities are intentionally separate:

- `app_rw` is the least-privilege application runtime and is subject to RLS.
- `ingest_rw` can write approved mirror tables through the ingest path.
- The database owner/admin identity is reserved for migrations and an explicitly
  approved manual synthetic-dev seed. Normal cloud deployments do not seed.

## Repository layout

```text
app/                    Next.js pages, Server Actions, and API routes
components/             Application UI and report components
lib/                    Domain logic, data access, auth, integrations, and AI
prisma/                 Prisma schema, synthetic seed, and all SQL migrations
warehouse/               Reviewed mirror of performance-report saved questions
infra/terraform/        Production-only Terraform stack
infra/terraform-dev/    Isolated development Terraform stack
test/                   Unit, database-integration, and deployed smoke tests
scripts/                Migration, operational, and Warehouse control scripts
docs/                   Architecture, compliance evidence, plans, and runbooks
.github/workflows/       CI, dev deployment, promotion controls, prod deployment
docker-compose.yml       Loopback-only PostgreSQL 16 for local development
```

## Local development

Prerequisites:

- Node.js 20 or newer
- npm
- Docker with Compose

Start a local synthetic environment:

```bash
cp .env.example .env
docker compose up -d
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and choose a seeded persona.
Try an advisor and an Operations/Admin persona to exercise role and RLS
differences. Local Postgres binds only to `127.0.0.1`, uses trust authentication,
and must never contain real client data.

Useful checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run test:db
npm run test:e2e:critical
npm run build
npm run audit:prod
```

The deployed browser smoke suite requires `PLAYWRIGHT_BASE_URL` and is normally
run by the dev deployment workflow:

```bash
PLAYWRIGHT_BASE_URL=https://example.run.app npm run test:e2e:smoke
```

## Configuration and secrets

- Copy [`.env.example`](.env.example) for local development; it documents every
  supported integration and feature flag without real credentials.
- Never commit secrets, client data, local `.env` files, Terraform plan files,
  or database exports.
- Deployed secret values live in each project's Secret Manager and are injected
  into Cloud Run at runtime. Terraform manages secret containers and access,
  not secret payloads.
- Do not copy production coordinates, credentials, service accounts, or data
  into the dev project.
- Infrastructure changes require a reviewed Terraform plan and the owner's
  explicit approval before apply.

## Operations and further reading

- [Progressive loading and navigation memory rollout](docs/planning/progressive-loading-navigation-memory.md) — Households pilot and remaining directory/history work.
- [Operations index and incident ownership](docs/operations/README.md)
- [Operational readiness checklist](docs/operations/readiness-checklist.md)
- [Data Health evidence and classifications](docs/operations/data-health.md)
- [CRM identity reconciliation](docs/operations/crm-identity-reconciliation.md)
- [Employee roster operations](docs/operations/employee-roster.md)
- [Zendesk ticket sync](docs/operations/zendesk-ticket-sync.md)
- [Deployment failure and rollback](docs/operations/deploy-failure.md)
- [Backup and point-in-time recovery](docs/operations/backup-restore.md)
- [Development infrastructure](infra/terraform-dev/README.md)
- [Production infrastructure](infra/terraform/README.md)
- [Warehouse report SQL and drift control](warehouse/README.md)
- [Performance-report methodology](docs/compliance/performance-report-methodology.md)
- [Trade Request linking design](docs/planning/trade-requests/trade-request-linking-design.md)
- [CRM source-of-record matrix](docs/planning/crm-relationship-layer/source-of-record-matrix.md)
- [Architecture and original design principles](docs/build-considerations.md)
