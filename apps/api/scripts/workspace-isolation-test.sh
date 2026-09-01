#!/usr/bin/env bash
# Cross-tenant leak test runner (issue #1393 acceptance criterion).
#
# Creates a DISPOSABLE database on a local Postgres, applies the full
# migration chain (including the new workspace_id backfill + RLS policies),
# then runs the workspace-isolation integration test against it with the
# REAL withWorkspace() path enabled.
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
DB_ROLE="${AURA_ISOLATION_DB_ROLE:-aura_isolation}"
DB_PASS="${AURA_ISOLATION_DB_PASS:-aura_isolation}"
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
psql_super -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_ROLE') THEN
    CREATE ROLE $DB_ROLE LOGIN PASSWORD '$DB_PASS' NOSUPERUSER NOBYPASSRLS;
  END IF;
END \$\$;"
psql_super -c "CREATE DATABASE $DB_NAME OWNER $DB_ROLE;"
# Pre-create extensions as superuser; the migrations' CREATE EXTENSION IF NOT
# EXISTS statements then no-op. Mirrors Neon, where the app role can install
# trusted extensions but is NOT superuser and has NO BYPASSRLS.
psql_super -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;"

export DATABASE_URL="postgres://$DB_ROLE:$DB_PASS@localhost:$DB_PORT/$DB_NAME"

echo "==> applying full migration chain (local disposable DB only)"
npx tsx scripts/apply-migrations-local.ts

echo "==> running workspace isolation test"
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
