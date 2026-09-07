#!/usr/bin/env bash
# Cross-tenant leak test runner (issue #1393 acceptance criterion).
#
# Provisions a DISPOSABLE local Postgres database, applies the full migration
# chain (workspace_id backfill, RLS policies, aura_app role) AS THE OWNER
# role, then runs the isolation suites AS THE `aura_app` ROLE **through a
# local PgBouncer in TRANSACTION pooling mode** — the same topology production
# has (Neon `-pooler` host): non-privileged role, no table ownership, and no
# guarantee that consecutive statements share a server backend. Both blind
# spots that previously let an inert configuration test green (BYPASSRLS role
# shape, direct-connection session GUCs) are structurally closed:
#   - the suite hard-fails under a bypassing/superuser/owner role;
#   - the pooler-concurrency suite fails any wrapper whose GUC does not travel
#     inside an explicit transaction (SET LOCAL).
#
# Requirements: local Postgres 15+ with pgvector, and pgbouncer, reachable as
# superuser via `sudo -u postgres psql` (Debian/Ubuntu) or $PGSUPER_URL.
#   sudo apt-get install postgresql-16 postgresql-16-pgvector pgbouncer
#
# This never touches a remote database: apply-migrations-local.ts hard-fails
# on non-localhost hosts.
set -euo pipefail

cd "$(dirname "$0")/.."

# Capture the ambient (production) DATABASE_URL BEFORE we override it to the
# local pooler below. If it is a Neon host, the HTTP leg of the concurrency
# test uses it (read-only) to exercise the DEFAULT production transport
# (neon-http batched transaction) and measure the scoped/unscoped latency
# ratio — the round-3 property a local pooler cannot show.
ORIG_DATABASE_URL="${DATABASE_URL:-}"

DB_NAME="${AURA_ISOLATION_DB_NAME:-aura_isolation_test}"
OWNER_ROLE="${AURA_ISOLATION_DB_ROLE:-aura_isolation}"
OWNER_PASS="${AURA_ISOLATION_DB_PASS:-aura_isolation}"
APP_ROLE="aura_app"
APP_PASS="${AURA_ISOLATION_APP_PASS:-aura_app_test}"
DB_PORT="${AURA_ISOLATION_DB_PORT:-5432}"
POOLER_PORT="${AURA_ISOLATION_POOLER_PORT:-6432}"

psql_super() {
  if [ -n "${PGSUPER_URL:-}" ]; then
    psql "$PGSUPER_URL" -v ON_ERROR_STOP=1 "$@"
  else
    sudo -u postgres psql -p "$DB_PORT" -v ON_ERROR_STOP=1 "$@"
  fi
}

echo "==> (re)creating disposable database $DB_NAME"
psql_super -c "DROP DATABASE IF EXISTS $DB_NAME;"
# Owner role mirrors neondb_owner's capabilities where they matter for the
# migration chain: owns the tables, can CREATE ROLE (0092 creates aura_app).
# It deliberately does NOT get BYPASSRLS -- the tests never run as the owner.
psql_super -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$OWNER_ROLE') THEN
    CREATE ROLE $OWNER_ROLE LOGIN PASSWORD '$OWNER_PASS' NOSUPERUSER NOBYPASSRLS CREATEROLE;
  ELSE
    ALTER ROLE $OWNER_ROLE LOGIN PASSWORD '$OWNER_PASS' NOSUPERUSER NOBYPASSRLS CREATEROLE;
  END IF;
END \$\$;"
psql_super -c "CREATE DATABASE $DB_NAME OWNER $OWNER_ROLE;"
# Pre-create extensions as superuser; the migrations' CREATE EXTENSION IF NOT
# EXISTS statements then no-op. Mirrors Neon, where the app role can install
# trusted extensions but is NOT superuser.
psql_super -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;"

echo "==> applying full migration chain as the OWNER role (local disposable DB only)"
DATABASE_URL="postgres://$OWNER_ROLE:$OWNER_PASS@localhost:$DB_PORT/$DB_NAME" \
  npx tsx scripts/apply-migrations-local.ts

# Out-of-band password step from the 0092 runbook: the migration creates
# aura_app without a password; the operator sets one and points DATABASE_URL
# at it. Superuser here stands in for the operator.
echo "==> setting aura_app password out of band (operator runbook step)"
psql_super -c "ALTER ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASS';"

echo "==> starting local PgBouncer (TRANSACTION pooling — production topology)"
PGB_DIR="$(mktemp -d /tmp/aura-pgbouncer.XXXXXX)"
cat > "$PGB_DIR/userlist.txt" <<USERS
"$APP_ROLE" "$APP_PASS"
USERS
cat > "$PGB_DIR/pgbouncer.ini" <<INI
[databases]
$DB_NAME = host=127.0.0.1 port=$DB_PORT dbname=$DB_NAME
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = $POOLER_PORT
auth_type = plain
auth_file = $PGB_DIR/userlist.txt
pool_mode = transaction
; small server pool + many clients forces backend multiplexing, which is what
; exposes session-scoped GUCs (the round-2 bug)
default_pool_size = 5
max_client_conn = 200
logfile = $PGB_DIR/pgbouncer.log
pidfile = $PGB_DIR/pgbouncer.pid
INI
pgbouncer -d "$PGB_DIR/pgbouncer.ini"
cleanup() {
  [ -f "$PGB_DIR/pgbouncer.pid" ] && kill "$(cat "$PGB_DIR/pgbouncer.pid")" 2>/dev/null || true
}
trap cleanup EXIT
for i in $(seq 1 20); do
  if PGPASSWORD="$APP_PASS" psql -h 127.0.0.1 -p "$POOLER_PORT" -U "$APP_ROLE" -d "$DB_NAME" -c "SELECT 1" >/dev/null 2>&1; then break; fi
  sleep 0.25
  [ "$i" = 20 ] && { echo "pgbouncer did not become ready"; exit 1; }
done

# App traffic goes THROUGH the pooler (as in production). The raw/maintenance
# client in the tests uses the DIRECT connection (operator sessions are
# direct per the 0091 runbook — session GUCs are unsafe through a transaction
# pooler, which is the entire point of the concurrency suite).
export DATABASE_URL="postgres://$APP_ROLE:$APP_PASS@localhost:$POOLER_PORT/$DB_NAME"
export DIRECT_DATABASE_URL="postgres://$APP_ROLE:$APP_PASS@localhost:$DB_PORT/$DB_NAME"

# The HTTP leg of the concurrency test uses a real Neon DSN (read-only). Only
# forward it when the ambient DATABASE_URL is a Neon host; otherwise the leg
# skips (describe.runIf) rather than failing.
case "$ORIG_DATABASE_URL" in
  *.neon.tech*|*.neon.build*)
    export NEON_HTTP_TEST_URL="$ORIG_DATABASE_URL"
    echo "==> HTTP leg enabled against ambient Neon DSN (read-only)"
    ;;
  *)
    echo "==> HTTP leg skipped (ambient DATABASE_URL is not a Neon host)"
    ;;
esac

echo "==> running workspace isolation + pooler-concurrency tests as role $APP_ROLE via pgbouncer :$POOLER_PORT"
# AI/rerank keys are cleared so the run is hermetic: retrieval falls back to
# its heuristic entity extraction + legacy scoring paths (both DB-only).
WORKSPACE_ISOLATION_TEST=1 \
WORKSPACE_POOLER_TEST=1 \
DEFAULT_WORKSPACE_ID=ws-a \
DASHBOARD_API_SECRET="isolation-test-secret" \
ELEVENLABS_API_KEY="placeholder" \
COHERE_API_KEY="" \
AI_GATEWAY_API_KEY="" \
ANTHROPIC_API_KEY="" \
OPENAI_API_KEY="" \
NEON_HTTP_TEST_URL="${NEON_HTTP_TEST_URL:-}" \
npx vitest run src/db/workspace-isolation.test.ts src/db/workspace-pooler-concurrency.test.ts "$@"
