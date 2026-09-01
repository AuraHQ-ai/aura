#!/usr/bin/env bash
# Cross-tenant leak test runner (issue #1393 acceptance criterion).
#
# Creates a DISPOSABLE database on a local Postgres, applies the full
# migration chain (including the workspace_id backfill, RLS policies, and the
# aura_app role) AS THE OWNER role, then runs the workspace-isolation
# integration test AS THE `aura_app` ROLE — the same split production has
# after the 0092 cutover (owner = migration runner only; aura_app = app
# traffic, NOSUPERUSER NOBYPASSRLS, owns nothing). The test fails hard if the
# role it runs under is RLS-exempt, so it can never again green-light a role
# shape the deployment target doesn't have.
#
# Requirements: a local Postgres 15+ with the pgvector extension available,
# reachable as superuser via `sudo -u postgres psql` (Debian/Ubuntu layout)
# or via $PGSUPER_URL.
#
# This never touches a remote database: apply-migrations-local.ts hard-fails
# on non-localhost hosts.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="${AURA_ISOLATION_DB_NAME:-aura_isolation_test}"
OWNER_ROLE="${AURA_ISOLATION_DB_ROLE:-aura_isolation}"
OWNER_PASS="${AURA_ISOLATION_DB_PASS:-aura_isolation}"
APP_ROLE="aura_app"
APP_PASS="${AURA_ISOLATION_APP_PASS:-aura_app_test}"
DB_PORT="${AURA_ISOLATION_DB_PORT:-5432}"

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

export DATABASE_URL="postgres://$APP_ROLE:$APP_PASS@localhost:$DB_PORT/$DB_NAME"

echo "==> running workspace isolation test as role $APP_ROLE"
# AI/rerank keys are cleared so the run is hermetic: retrieval falls back to
# its heuristic entity extraction + legacy scoring paths (both DB-only).
WORKSPACE_ISOLATION_TEST=1 \
DEFAULT_WORKSPACE_ID=ws-a \
DASHBOARD_API_SECRET="isolation-test-secret" \
ELEVENLABS_API_KEY="placeholder" \
COHERE_API_KEY="" \
AI_GATEWAY_API_KEY="" \
ANTHROPIC_API_KEY="" \
OPENAI_API_KEY="" \
npx vitest run src/db/workspace-isolation.test.ts "$@"
