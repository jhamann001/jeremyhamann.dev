# Database

Single Cloud SQL Postgres instance (prod) / local Postgres (dev), organized into **five schemas** with different rules:

| Schema | Owner / writer | App access | Notes |
|--------|----------------|-----------|-------|
| `app` | the application (Prisma) | read-write | users, roles, decisions, tax budgets, reminders, nudges, illustrations |
| `audit` | the application | **insert + select only** | append-only log; no UPDATE/DELETE grant |
| `mirror` | **n8n ingestion only** | **read-only** | ingested copies of Salesforce/Apex/Plaid/etc.; the app never writes here |
| `statement_pipeline` | **statement-pipeline service only** (`statement_pipeline_rw`) | **none** | the statement-pipeline's tables (ticket), moved from its own database; AoA app roles hold no privilege here |
| `trade_request` | the AoA Trade Request backend (ticket) | `app_rw` read-write on the 14 record tables, read-only on serving state and the copy ledger; `trade_request_mcp_ro` read-only for the standalone MCP | written by the copy engine (`scripts/trade-requests/copy.ts`) until the cutover |

**Rules**
- Ingestion (n8n) writes **only** to `mirror`. It must never touch `app`/`audit`.
- The app writes `app`/`audit`, reads `mirror`.
- **Row-Level Security** scopes rows to the signed-in user's role (Okta group → role), via per-request GUCs (`app.user_role`, `app.user_email`) set by [`../lib/rls.ts`](../lib/rls.ts). Missing context fails closed (no rows).
- Two DB roles enforce least privilege: **`app_rw`** (app runtime — RLS applies to it) and **`ingest_rw`** (n8n — writes `mirror` only). Migrations/seed run as the owner.
- **`statement_pipeline_rw`** (Terraform-managed login, password in `statement-pipeline-rw-db-password`) reads and writes only `statement_pipeline`. Its migration [`../prisma/migrations/20261008120000_statement_pipeline_schema/migration.sql`](../prisma/migrations/20261008120000_statement_pipeline_schema/migration.sql) fails closed on Cloud SQL until Terraform has created the login.
- **`trade_request_mcp_ro`** (Terraform-managed login; production password in `trade-request-mcp-ro-db-password`, read only by the standalone Trade Request runtime) has `SELECT` on the `trade_request` tables MCP reads and the `trade_request.mcp_access` view, nothing else. Its migration [`../prisma/migrations/20261101120000_trade_request_schema/migration.sql`](../prisma/migrations/20261101120000_trade_request_schema/migration.sql) fails closed on Cloud SQL until Terraform has created the login.
- **`trade_request` foreign keys:** no table outside the 14 record tables may declare a foreign key to one of them; store the referenced key as a plain column. The copy engine refuses to write while such a key exists.
- **`trade_request.mcp_access`** reads `app."User".email` and `.role`: a migration that rebuilds the `Role` enum or those columns must drop and recreate the view.
- Every migration is **reversible** and reviewed before it touches prod (no cloud staging — local is the rehearsal).

**Tooling**
- Prisma manages the `app` + `audit` models ([`../prisma/schema.prisma`](../prisma/schema.prisma)) and their migrations.
- The `mirror` schema/tables, the DB roles, all **grants**, and all **RLS policies** live in the hand-authored migration [`../prisma/migrations/20260629221205_mirror_roles_grants_rls/migration.sql`](../prisma/migrations/20260629221205_mirror_roles_grants_rls/migration.sql) (Prisma doesn't own RLS). [`rls.sql`](rls.sql) is kept only as an annotated design reference.

> Mirror table definitions come from the Salesforce → mirror mapping in [`../docs/salesforce-mirror-mapping.md`](../docs/salesforce-mirror-mapping.md) (and later Apex/Plaid/etc.).
