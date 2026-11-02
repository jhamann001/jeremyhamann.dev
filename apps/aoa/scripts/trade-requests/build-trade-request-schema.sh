#!/usr/bin/env bash
# Regenerates the trade_request table DDL from the standalone service's migrations (ticket).
# Usage: TRADE_REQUEST_SERVICE_DIR=/path/to/trade-request scripts/trade-requests/build-trade-request-schema.sh > /tmp/trade_request_tables.sql
set -euo pipefail
: "${TRADE_REQUEST_SERVICE_DIR:?set TRADE_REQUEST_SERVICE_DIR to a trade-request checkout}"
SCRATCH="trb_schema_src_$$"
TABLES="users clients accounts trade_requests audit_logs notifications client_exclusions account_exclusions digest_runs registry_drift_runs position_drift_accounts drift_alert_sends drift_status_overrides security_sector"
createdb "$SCRATCH"
trap 'dropdb --if-exists "$SCRATCH"' EXIT
(cd "$TRADE_REQUEST_SERVICE_DIR/server" && DATABASE_URL="postgres://localhost:5432/$SCRATCH" npx node-pg-migrate up --migrations-dir migrations >/dev/null)
ARGS=()
for t in $TABLES; do ARGS+=(-t "public.$t"); done
# pg_dump 16.10+/17.6+/18 emit \restrict and \unrestrict lines with a random key; drop them so the output is SQL and reproducible.
pg_dump --schema-only --no-owner --no-privileges --no-comments "${ARGS[@]}" "postgres://localhost:5432/$SCRATCH" \
  | grep -vE '^(\\(un)?restrict |SET |SELECT pg_catalog\.set_config|--)' \
  | sed -e 's/public\.uuid_generate_v4()/gen_random_uuid()/g' -e 's/public\./trade_request./g' \
  | cat -s
