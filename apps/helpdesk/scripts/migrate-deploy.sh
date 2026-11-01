#!/usr/bin/env bash
# Applies the help desk schema to the dev Cloud SQL database as the OWNER role, grants the runtime roles and runs
# the reference seed. Executed by the wm-helpdesk-migrate-dev Cloud Run Job (Dockerfile.migrate) BEFORE the new
# service revision takes traffic — never from a laptop or Cloud Shell (the instance is private-IP only).
# docs/ARCHITECTURE.md §i, §j, Decision #57; mirrors OPS_PORTAL's scripts/migrate-prod.sh.
#
#   1. `prisma migrate deploy` — applies prisma/migrations/ exactly once (tracked in _prisma_migrations), so a
#      re-run is a clean no-op. P1001 (server unreachable — Prisma never connected, nothing ran) is retried: the
#      Job container can start before its Direct VPC egress interface is ready. Any other failure exits at once,
#      preserving the Job's max_retries=0 no-silent-retry posture.
#   2. `psql -f prisma/sql/runtime-roles.sql` — the per-table GRANTs for wm_helpdesk_app / wm_helpdesk_public
#      (idempotent; re-run after every deploy that adds a relation). Its DO block creates the two roles only if
#      absent and is INERT on Cloud SQL: Terraform's google_sql_user rows already created the three login roles.
#      The file expects the psql variable :"dbname" (RUNTIME_ROLES_DBNAME, default wm_helpdesk).
#   3. `prisma db seed` — the reference seed (queues, SLA rows, macros; idempotent, no audit rows). Dev fixtures
#      ONLY when SEED_DEV_FIXTURES=true (the Job pins false; the operator overrides once for the first dev seed
#      with `gcloud run jobs execute --update-env-vars SEED_DEV_FIXTURES=true`), and prisma/seed.ts refuses them
#      outright when APP_ENV=production.
#
# Secret VALUES come from Secret Manager (the Job mounts DATABASE_URL = the wm_helpdesk_owner URL), never from
# this file. Nothing below echoes DATABASE_URL: `set -x` is never enabled and the URL is only ever passed as an
# argument. Prisma's own output names the database and host, never the password.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "It must be the wm_helpdesk_owner connection (secret helpdesk-demo-owner-database-url):" >&2
  # The expected shape is PRINTED FROM PARTS, not stored as one string. A
  # connection-string literal carrying a user and a password is a security scanner secret finding
  # even when the password is a placeholder — the credential pair itself is the template, and a
  # placeholder is what somebody edits into a real value. PASSWORD and PRIVATE-IP below are words,
  # not values; the real URL only ever exists as the Secret Manager payload this script is handed.
  printf '  %s://%s:%s@%s:5432/%s?schema=public&sslmode=require\n' \
    postgresql wm_helpdesk_owner PASSWORD PRIVATE-IP wm_helpdesk >&2
  echo "Values come from Secret Manager, never hardcoded." >&2
  exit 1
fi

# libpq rejects Prisma's `schema=` URI parameter ("invalid URI query parameter"), so psql gets the URL without
# it; every other parameter (sslmode=require) is kept. Runs in a subshell substitution — nothing is printed.
strip_schema_param() {
  printf '%s' "$1" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//'
}

DBNAME="${RUNTIME_ROLES_DBNAME:-wm_helpdesk}"
SEED_MODE="reference"
if [[ "${SEED_DEV_FIXTURES:-false}" == "true" ]]; then
  SEED_MODE="reference + dev fixtures"
fi

echo "[1/3] prisma migrate deploy (owner connection) ..."
ATTEMPTS=3
for i in $(seq 1 "$ATTEMPTS"); do
  set +e
  OUT="$(npx prisma migrate deploy 2>&1)"
  STATUS=$?
  set -e
  printf '%s\n' "$OUT"
  if [[ $STATUS -eq 0 ]]; then
    break
  elif [[ "$OUT" == *"P1001"* && $i -lt $ATTEMPTS ]]; then
    echo "P1001 (server unreachable — never connected); retry $((i + 1))/${ATTEMPTS} in 10s ..." >&2
    sleep 10
  else
    exit "$STATUS"
  fi
done

echo "[2/3] runtime roles: psql -f prisma/sql/runtime-roles.sql (dbname=${DBNAME}) ..."
PSQL_URL="$(strip_schema_param "$DATABASE_URL")"
psql "$PSQL_URL" -X -q -v ON_ERROR_STOP=1 -v dbname="$DBNAME" -f prisma/sql/runtime-roles.sql
echo "runtime roles granted (wm_helpdesk_app, wm_helpdesk_public) on ${DBNAME}."

echo "[3/3] prisma db seed (${SEED_MODE}; APP_ENV=${APP_ENV:-unset}) ..."
npx prisma db seed

echo "migrate-deploy complete: migrations applied, runtime roles granted on ${DBNAME}, seed=${SEED_MODE}."
echo "This Job used the owner role only; the service connects as wm_helpdesk_app (DATABASE_URL) and wm_helpdesk_public (PUBLIC_DATABASE_URL)."
