#!/usr/bin/env bash
# Captures the standalone service's answers to the read-parity cases (ticket) through AOA's delegated client.
# Usage: TRADE_REQUEST_SERVICE_DIR=/path/to/trade-request scripts/trade-requests/capture-read-parity.sh <out.json>
# Uses only scratch databases (created and dropped here) and synthetic data. Needs local Postgres 16 with the
# aoa role, and the standalone checkout with npm ci done.
set -euo pipefail
: "${TRADE_REQUEST_SERVICE_DIR:?set TRADE_REQUEST_SERVICE_DIR to a trade-request checkout}"
OUT="${1:?usage: capture-read-parity.sh <out.json>}"
ROOT="$(pwd)"
PORT="${TRADE_REQUEST_PARITY_PORT:-18406}"
KEY="trade-request-parity-local-key"
SRC="trb_parity_capture_src"
AOA_DB="trb_parity_capture_aoa"
PID=""

# No feed may be configured: the local service must read the seeded records, never Warehouse, Meridian, S3 or GCS.
for v in WAREHOUSE_URL WAREHOUSE_API_KEY WAREHOUSE_CONTACTS_QUESTION_ID WAREHOUSE_INVESTMENTS_QUESTION_ID \
  WAREHOUSE_BALANCES_QUESTION_ID WAREHOUSE_STOCK_RECORD_QUESTION_ID WAREHOUSE_COST_BASIS_DB_ID WAREHOUSE_COST_BASIS_DB_IDS \
  MERIDIAN_SNAPSHOT_SOURCE MERIDIAN_SNAPSHOT_BUCKET MERIDIAN_SNAPSHOT_FILE MERIDIAN_SNAPSHOT_S3_BUCKET \
  MERIDIAN_SNAPSHOT_S3_REGION MERIDIAN_SNAPSHOT_S3_PREFIX AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  AWS_SESSION_TOKEN AWS_PROFILE GOOGLE_APPLICATION_CREDENTIALS; do
  unset "$v"
done

cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  dropdb --if-exists "$SRC" > /dev/null 2>&1 || true
  dropdb --if-exists "$AOA_DB" > /dev/null 2>&1 || true
}
trap cleanup EXIT

dropdb --if-exists "$SRC" > /dev/null 2>&1
createdb "$SRC"
(cd "$TRADE_REQUEST_SERVICE_DIR/server" && DATABASE_URL="postgres://localhost:5432/$SRC" npx node-pg-migrate up --migrations-dir migrations > /dev/null)
psql -q -v ON_ERROR_STOP=1 "postgres://localhost:5432/$SRC" -f "$ROOT/test/fixtures/trade-request-read-parity-seed.sql"

dropdb --if-exists "$AOA_DB" > /dev/null 2>&1
createdb -O aoa "$AOA_DB"
DIRECT_DATABASE_URL="postgresql://aoa@localhost:5432/$AOA_DB?schema=app" DATABASE_URL="postgresql://aoa@localhost:5432/$AOA_DB?schema=app" \
  npx prisma migrate deploy > /dev/null
psql -q -v ON_ERROR_STOP=1 "postgresql://aoa@localhost:5432/$AOA_DB" -f "$ROOT/test/fixtures/trade-request-read-parity-aoa-users.sql"

(
  cd "$TRADE_REQUEST_SERVICE_DIR/server"
  exec env -i PATH="$PATH" HOME="$HOME" TZ=UTC NODE_ENV=development PORT="$PORT" DB_HOST=localhost DB_PORT=5432 DB_NAME="$SRC" DB_USER="$USER" \
    GOOGLE_CLIENT_ID=synthetic GOOGLE_CLIENT_SECRET=synthetic SESSION_SECRET=synthetic-session \
    AOA_DELEGATED_LOCAL_KEY="$KEY" AOA_DELEGATED_AUDIENCE="http://127.0.0.1:$PORT/api/aoa" \
    AOA_DELEGATED_CALLER_SA=aoa-local@delegated.invalid ALLOWED_EMAIL_DOMAIN=example.test \
    RATE_LIMIT_USER_MAX=100000 LOG_LEVEL=silent ../node_modules/.bin/tsx src/index.ts
) > /tmp/trade-request-parity-server.log 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null

TZ=UTC DATABASE_URL="postgresql://aoa@localhost:5432/$AOA_DB?schema=app" \
  TRADE_REQUEST_PARITY_CAPTURE_URL="http://127.0.0.1:$PORT" TRADE_REQUEST_PARITY_CAPTURE_KEY="$KEY" \
  TRADE_REQUEST_PARITY_OUT="$OUT" npx vitest run test/trade-request-read-parity.capture.test.ts > /dev/null
