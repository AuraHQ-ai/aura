-- Multi-tenancy Phase 0 (issue #1393, part of #17): dedicated non-privileged
-- application role.
--
-- WHY THIS EXISTS
-- ===============
-- The RLS policies from 0091 are INERT for any role with the BYPASSRLS
-- attribute, and on production Neon the table owner / current app identity
-- (`neondb_owner`) HAS BYPASSRLS (verified live). FORCE ROW LEVEL SECURITY
-- does not help: it removes the owner exemption, not the role-attribute
-- exemption. So the application must connect as a role that
--   - is NOT a superuser,
--   - does NOT have BYPASSRLS,
--   - does NOT own the tables (defence in depth; FORCE covers owners, but
--     `aura_app` owning nothing means two independent exemptions would have
--     to regress before RLS goes inert),
--   - can do plain DML and nothing else (no CREATEROLE, no CREATEDB).
--
-- ROLE SPLIT AFTER THIS MIGRATION
-- ===============================
--   neondb_owner  table owner; migration-runner identity ONLY (the Vercel
--                 build's `db:migrate` step). Its BYPASSRLS means future DML
--                 migrations keep working unchanged.
--   aura_app      the application identity. All runtime DATABASE_URL traffic
--                 (neon-http base driver AND the withWorkspace() pools).
--
-- OPERATOR CUTOVER (out of band -- NOT in this file)
-- ==================================================
-- The password is deliberately NOT set here (migration files are committed
-- to the repo). After this migration runs, the operator:
--   1. ALTER ROLE aura_app PASSWORD '<generated out of band>';
--      (or use Neon's role management to set/rotate the password)
--   2. Point the app's DATABASE_URL env var at aura_app and redeploy.
--   3. Verify: the boot assertion in apps/api/src/db/workspace.ts logs
--      nothing; SELECT current_user shows aura_app; the dashboard works.
-- ROLLBACK: point DATABASE_URL back at the neondb_owner connection string
-- and redeploy. Nothing else changes -- grants and the role are additive and
-- harmless while unused. Full runbook in PR #1396.
--
-- IDEMPOTENCY: safe to re-run; tolerates the role already existing, and
-- re-asserts the privilege-less shape either way.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aura_app') THEN
    CREATE ROLE aura_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END $$;--> statement-breakpoint

-- Verify the shape even when the role pre-existed. We cannot ALTER the
-- SUPERUSER/BYPASSRLS attributes here (only superusers may touch them, and
-- the migration runner is not one) — so a pre-existing, RLS-exempt aura_app
-- FAILS the migration loudly instead of silently shipping inert containment.
-- The operator must then fix or drop/recreate the role.
DO $$
DECLARE r record;
BEGIN
  SELECT rolbypassrls, rolsuper INTO r FROM pg_roles WHERE rolname = 'aura_app';
  IF r.rolbypassrls OR r.rolsuper THEN
    RAISE EXCEPTION
      'aura_app exists but is RLS-exempt (rolbypassrls=%, rolsuper=%). '
      'RLS containment would be INERT for it. Drop or fix the role, then re-run.',
      r.rolbypassrls, r.rolsuper;
  END IF;
END $$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO aura_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aura_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aura_app;--> statement-breakpoint

-- Future-proofing: tables/sequences created by LATER migrations must not
-- silently drop aura_app's grants. ALTER DEFAULT PRIVILEGES (without FOR
-- ROLE) binds to the role executing this migration — which is exactly the
-- migration-runner identity that will also create those future tables
-- (`neondb_owner` on production, the database owner on local replays). A
-- literal `FOR ROLE neondb_owner` would error on any database where that
-- role does not exist (e.g. the isolation test's local replay).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aura_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aura_app;
