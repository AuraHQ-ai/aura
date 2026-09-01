-- Multi-tenancy Phase 0 (issue #1393, part of #17): row-level security on
-- every tenant table. Deny-by-default: a connection that has not set
-- `app.workspace_id` sees ZERO rows and cannot write ANY row. Enforcement
-- lives here, in one place, instead of in ~400 hand-patched query sites.
--
-- POLICY MODEL
-- ============
-- Two PERMISSIVE policies per table (permissive policies OR together):
--   <t>_workspace_isolation  row.workspace_id = current_setting('app.workspace_id', true)
--   <t>_maintenance          current_setting('app.rls_bypass', true) = 'maintenance'
-- With neither GUC set, current_setting(..., true) returns NULL (or '' after
-- a RESET), both policies evaluate false, and access is denied. The app never
-- sets app.rls_bypass; only operator-driven maintenance sessions do.
--
-- ROLE ASSUMPTIONS -- READ BEFORE RUNNING (issue #1393 requires sign-off)
-- ======================================================================
-- 1. One database role (Neon: `neondb_owner`) OWNS all tables and is used by
--    (a) the application, (b) this migration runner, (c) maintenance scripts.
--    It is NOT a superuser and does NOT have BYPASSRLS. That is why every
--    table gets FORCE ROW LEVEL SECURITY: without FORCE, RLS is a no-op for
--    the table owner and this whole migration would enforce nothing.
-- 2. THIS migration is DDL-only (ENABLE/FORCE/CREATE POLICY). RLS never
--    blocks DDL, so the migration cannot lock itself out while running.
-- 3. FUTURE migrations that run DML (UPDATE/INSERT backfills) against these
--    tables MUST account for FORCE RLS. The hash-based runner
--    (packages/db/src/migrate.ts) executes each statement as an independent
--    stateless neon-http query, so session GUCs do NOT persist between
--    statements. The supported pattern is to bracket the DML per table:
--        ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY;
--        UPDATE "t" SET ...;   -- owner bypasses non-forced RLS
--        ALTER TABLE "t" FORCE ROW LEVEL SECURITY;
--    (Do NOT use DISABLE ROW LEVEL SECURITY: NO FORCE keeps enforcement live
--    for every non-owner role during the migration window.)
-- 4. Maintenance scripts / psql sessions that legitimately need cross-tenant
--    access must run, on their own session:
--        SELECT set_config('app.rls_bypass', 'maintenance', false);
--    The application NEVER sets this GUC; withWorkspace() only ever sets
--    app.workspace_id.
-- 5. The application reaches these tables through withWorkspace()
--    (apps/api/src/db/workspace.ts), which pins a connection and issues
--    set_config('app.workspace_id', $1, ...) before running any queries.
--
-- TABLES DELIBERATELY EXCLUDED
-- ============================
--   workspaces  the tenant registry itself (no workspace_id; resolving a
--               tenant requires reading it before a tenant context exists)
--   content     global blog/docs index for the public marketing site; it has
--               no workspace_id column and holds no tenant data. (Issue #1393
--               says "40 tenant tables"; the live count is 39 because content
--               is global -- called out in the PR for reviewer sign-off.)
--
-- 39 tenant tables get ENABLE + FORCE + the two policies below.

-- messages
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "messages_workspace_isolation" ON "messages";--> statement-breakpoint
CREATE POLICY "messages_workspace_isolation" ON "messages" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "messages_maintenance" ON "messages";--> statement-breakpoint
CREATE POLICY "messages_maintenance" ON "messages" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- memories
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "memories_workspace_isolation" ON "memories";--> statement-breakpoint
CREATE POLICY "memories_workspace_isolation" ON "memories" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "memories_maintenance" ON "memories";--> statement-breakpoint
CREATE POLICY "memories_maintenance" ON "memories" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- entities
ALTER TABLE "entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "entities_workspace_isolation" ON "entities";--> statement-breakpoint
CREATE POLICY "entities_workspace_isolation" ON "entities" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "entities_maintenance" ON "entities";--> statement-breakpoint
CREATE POLICY "entities_maintenance" ON "entities" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- entity_aliases
ALTER TABLE "entity_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entity_aliases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "entity_aliases_workspace_isolation" ON "entity_aliases";--> statement-breakpoint
CREATE POLICY "entity_aliases_workspace_isolation" ON "entity_aliases" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "entity_aliases_maintenance" ON "entity_aliases";--> statement-breakpoint
CREATE POLICY "entity_aliases_maintenance" ON "entity_aliases" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- memory_entities
ALTER TABLE "memory_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_entities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "memory_entities_workspace_isolation" ON "memory_entities";--> statement-breakpoint
CREATE POLICY "memory_entities_workspace_isolation" ON "memory_entities" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "memory_entities_maintenance" ON "memory_entities";--> statement-breakpoint
CREATE POLICY "memory_entities_maintenance" ON "memory_entities" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- users
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "users_workspace_isolation" ON "users";--> statement-breakpoint
CREATE POLICY "users_workspace_isolation" ON "users" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "users_maintenance" ON "users";--> statement-breakpoint
CREATE POLICY "users_maintenance" ON "users" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- addresses
ALTER TABLE "addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "addresses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "addresses_workspace_isolation" ON "addresses";--> statement-breakpoint
CREATE POLICY "addresses_workspace_isolation" ON "addresses" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "addresses_maintenance" ON "addresses";--> statement-breakpoint
CREATE POLICY "addresses_maintenance" ON "addresses" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- channels
ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "channels_workspace_isolation" ON "channels";--> statement-breakpoint
CREATE POLICY "channels_workspace_isolation" ON "channels" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "channels_maintenance" ON "channels";--> statement-breakpoint
CREATE POLICY "channels_maintenance" ON "channels" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- settings
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "settings_workspace_isolation" ON "settings";--> statement-breakpoint
CREATE POLICY "settings_workspace_isolation" ON "settings" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "settings_maintenance" ON "settings";--> statement-breakpoint
CREATE POLICY "settings_maintenance" ON "settings" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- model_catalog
ALTER TABLE "model_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_catalog" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "model_catalog_workspace_isolation" ON "model_catalog";--> statement-breakpoint
CREATE POLICY "model_catalog_workspace_isolation" ON "model_catalog" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "model_catalog_maintenance" ON "model_catalog";--> statement-breakpoint
CREATE POLICY "model_catalog_maintenance" ON "model_catalog" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- notes
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "notes_workspace_isolation" ON "notes";--> statement-breakpoint
CREATE POLICY "notes_workspace_isolation" ON "notes" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "notes_maintenance" ON "notes";--> statement-breakpoint
CREATE POLICY "notes_maintenance" ON "notes" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- resources
ALTER TABLE "resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "resources_workspace_isolation" ON "resources";--> statement-breakpoint
CREATE POLICY "resources_workspace_isolation" ON "resources" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "resources_maintenance" ON "resources";--> statement-breakpoint
CREATE POLICY "resources_maintenance" ON "resources" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- jobs
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "jobs_workspace_isolation" ON "jobs";--> statement-breakpoint
CREATE POLICY "jobs_workspace_isolation" ON "jobs" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "jobs_maintenance" ON "jobs";--> statement-breakpoint
CREATE POLICY "jobs_maintenance" ON "jobs" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- job_executions
ALTER TABLE "job_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_executions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "job_executions_workspace_isolation" ON "job_executions";--> statement-breakpoint
CREATE POLICY "job_executions_workspace_isolation" ON "job_executions" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "job_executions_maintenance" ON "job_executions";--> statement-breakpoint
CREATE POLICY "job_executions_maintenance" ON "job_executions" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- job_outcomes
ALTER TABLE "job_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_outcomes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "job_outcomes_workspace_isolation" ON "job_outcomes";--> statement-breakpoint
CREATE POLICY "job_outcomes_workspace_isolation" ON "job_outcomes" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "job_outcomes_maintenance" ON "job_outcomes";--> statement-breakpoint
CREATE POLICY "job_outcomes_maintenance" ON "job_outcomes" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- detached_commands
ALTER TABLE "detached_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "detached_commands" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "detached_commands_workspace_isolation" ON "detached_commands";--> statement-breakpoint
CREATE POLICY "detached_commands_workspace_isolation" ON "detached_commands" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "detached_commands_maintenance" ON "detached_commands";--> statement-breakpoint
CREATE POLICY "detached_commands_maintenance" ON "detached_commands" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- model_pricing
ALTER TABLE "model_pricing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_pricing" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "model_pricing_workspace_isolation" ON "model_pricing";--> statement-breakpoint
CREATE POLICY "model_pricing_workspace_isolation" ON "model_pricing" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "model_pricing_maintenance" ON "model_pricing";--> statement-breakpoint
CREATE POLICY "model_pricing_maintenance" ON "model_pricing" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- conversation_traces
ALTER TABLE "conversation_traces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_traces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_traces_workspace_isolation" ON "conversation_traces";--> statement-breakpoint
CREATE POLICY "conversation_traces_workspace_isolation" ON "conversation_traces" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_traces_maintenance" ON "conversation_traces";--> statement-breakpoint
CREATE POLICY "conversation_traces_maintenance" ON "conversation_traces" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- conversation_messages
ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_messages_workspace_isolation" ON "conversation_messages";--> statement-breakpoint
CREATE POLICY "conversation_messages_workspace_isolation" ON "conversation_messages" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_messages_maintenance" ON "conversation_messages";--> statement-breakpoint
CREATE POLICY "conversation_messages_maintenance" ON "conversation_messages" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- conversation_parts
ALTER TABLE "conversation_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_parts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_parts_workspace_isolation" ON "conversation_parts";--> statement-breakpoint
CREATE POLICY "conversation_parts_workspace_isolation" ON "conversation_parts" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_parts_maintenance" ON "conversation_parts";--> statement-breakpoint
CREATE POLICY "conversation_parts_maintenance" ON "conversation_parts" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- dashboard_chat_runs
ALTER TABLE "dashboard_chat_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboard_chat_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "dashboard_chat_runs_workspace_isolation" ON "dashboard_chat_runs";--> statement-breakpoint
CREATE POLICY "dashboard_chat_runs_workspace_isolation" ON "dashboard_chat_runs" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "dashboard_chat_runs_maintenance" ON "dashboard_chat_runs";--> statement-breakpoint
CREATE POLICY "dashboard_chat_runs_maintenance" ON "dashboard_chat_runs" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- event_locks
ALTER TABLE "event_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_locks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "event_locks_workspace_isolation" ON "event_locks";--> statement-breakpoint
CREATE POLICY "event_locks_workspace_isolation" ON "event_locks" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "event_locks_maintenance" ON "event_locks";--> statement-breakpoint
CREATE POLICY "event_locks_maintenance" ON "event_locks" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- conversation_locks
ALTER TABLE "conversation_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_locks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_locks_workspace_isolation" ON "conversation_locks";--> statement-breakpoint
CREATE POLICY "conversation_locks_workspace_isolation" ON "conversation_locks" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_locks_maintenance" ON "conversation_locks";--> statement-breakpoint
CREATE POLICY "conversation_locks_maintenance" ON "conversation_locks" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- stop_events
ALTER TABLE "stop_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stop_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "stop_events_workspace_isolation" ON "stop_events";--> statement-breakpoint
CREATE POLICY "stop_events_workspace_isolation" ON "stop_events" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "stop_events_maintenance" ON "stop_events";--> statement-breakpoint
CREATE POLICY "stop_events_maintenance" ON "stop_events" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- turn_markers
ALTER TABLE "turn_markers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "turn_markers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "turn_markers_workspace_isolation" ON "turn_markers";--> statement-breakpoint
CREATE POLICY "turn_markers_workspace_isolation" ON "turn_markers" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "turn_markers_maintenance" ON "turn_markers";--> statement-breakpoint
CREATE POLICY "turn_markers_maintenance" ON "turn_markers" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- deferred_tool_thread_cache
ALTER TABLE "deferred_tool_thread_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deferred_tool_thread_cache" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "deferred_tool_thread_cache_workspace_isolation" ON "deferred_tool_thread_cache";--> statement-breakpoint
CREATE POLICY "deferred_tool_thread_cache_workspace_isolation" ON "deferred_tool_thread_cache" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "deferred_tool_thread_cache_maintenance" ON "deferred_tool_thread_cache";--> statement-breakpoint
CREATE POLICY "deferred_tool_thread_cache_maintenance" ON "deferred_tool_thread_cache" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- app_context_cache
ALTER TABLE "app_context_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_context_cache" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "app_context_cache_workspace_isolation" ON "app_context_cache";--> statement-breakpoint
CREATE POLICY "app_context_cache_workspace_isolation" ON "app_context_cache" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "app_context_cache_maintenance" ON "app_context_cache";--> statement-breakpoint
CREATE POLICY "app_context_cache_maintenance" ON "app_context_cache" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- error_events
ALTER TABLE "error_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "error_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "error_events_workspace_isolation" ON "error_events";--> statement-breakpoint
CREATE POLICY "error_events_workspace_isolation" ON "error_events" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "error_events_maintenance" ON "error_events";--> statement-breakpoint
CREATE POLICY "error_events_maintenance" ON "error_events" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- emails_raw
ALTER TABLE "emails_raw" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "emails_raw" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "emails_raw_workspace_isolation" ON "emails_raw";--> statement-breakpoint
CREATE POLICY "emails_raw_workspace_isolation" ON "emails_raw" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "emails_raw_maintenance" ON "emails_raw";--> statement-breakpoint
CREATE POLICY "emails_raw_maintenance" ON "emails_raw" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- oauth_tokens
ALTER TABLE "oauth_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "oauth_tokens_workspace_isolation" ON "oauth_tokens";--> statement-breakpoint
CREATE POLICY "oauth_tokens_workspace_isolation" ON "oauth_tokens" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "oauth_tokens_maintenance" ON "oauth_tokens";--> statement-breakpoint
CREATE POLICY "oauth_tokens_maintenance" ON "oauth_tokens" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- voice_calls
ALTER TABLE "voice_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "voice_calls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "voice_calls_workspace_isolation" ON "voice_calls";--> statement-breakpoint
CREATE POLICY "voice_calls_workspace_isolation" ON "voice_calls" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "voice_calls_maintenance" ON "voice_calls";--> statement-breakpoint
CREATE POLICY "voice_calls_maintenance" ON "voice_calls" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- action_log
ALTER TABLE "action_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "action_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "action_log_workspace_isolation" ON "action_log";--> statement-breakpoint
CREATE POLICY "action_log_workspace_isolation" ON "action_log" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "action_log_maintenance" ON "action_log";--> statement-breakpoint
CREATE POLICY "action_log_maintenance" ON "action_log" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- feedback
ALTER TABLE "feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "feedback_workspace_isolation" ON "feedback";--> statement-breakpoint
CREATE POLICY "feedback_workspace_isolation" ON "feedback" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "feedback_maintenance" ON "feedback";--> statement-breakpoint
CREATE POLICY "feedback_maintenance" ON "feedback" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- credentials
ALTER TABLE "credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "credentials_workspace_isolation" ON "credentials";--> statement-breakpoint
CREATE POLICY "credentials_workspace_isolation" ON "credentials" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "credentials_maintenance" ON "credentials";--> statement-breakpoint
CREATE POLICY "credentials_maintenance" ON "credentials" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- credential_grants
ALTER TABLE "credential_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credential_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "credential_grants_workspace_isolation" ON "credential_grants";--> statement-breakpoint
CREATE POLICY "credential_grants_workspace_isolation" ON "credential_grants" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "credential_grants_maintenance" ON "credential_grants";--> statement-breakpoint
CREATE POLICY "credential_grants_maintenance" ON "credential_grants" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- credential_audit_log
ALTER TABLE "credential_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credential_audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "credential_audit_log_workspace_isolation" ON "credential_audit_log";--> statement-breakpoint
CREATE POLICY "credential_audit_log_workspace_isolation" ON "credential_audit_log" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "credential_audit_log_maintenance" ON "credential_audit_log";--> statement-breakpoint
CREATE POLICY "credential_audit_log_maintenance" ON "credential_audit_log" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- bench_runs
ALTER TABLE "bench_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bench_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "bench_runs_workspace_isolation" ON "bench_runs";--> statement-breakpoint
CREATE POLICY "bench_runs_workspace_isolation" ON "bench_runs" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "bench_runs_maintenance" ON "bench_runs";--> statement-breakpoint
CREATE POLICY "bench_runs_maintenance" ON "bench_runs" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- eval_response_scores
ALTER TABLE "eval_response_scores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_response_scores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "eval_response_scores_workspace_isolation" ON "eval_response_scores";--> statement-breakpoint
CREATE POLICY "eval_response_scores_workspace_isolation" ON "eval_response_scores" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "eval_response_scores_maintenance" ON "eval_response_scores";--> statement-breakpoint
CREATE POLICY "eval_response_scores_maintenance" ON "eval_response_scores" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');--> statement-breakpoint

-- github_pull_requests
ALTER TABLE "github_pull_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_pull_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "github_pull_requests_workspace_isolation" ON "github_pull_requests";--> statement-breakpoint
CREATE POLICY "github_pull_requests_workspace_isolation" ON "github_pull_requests" AS PERMISSIVE FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "github_pull_requests_maintenance" ON "github_pull_requests";--> statement-breakpoint
CREATE POLICY "github_pull_requests_maintenance" ON "github_pull_requests" AS PERMISSIVE FOR ALL USING (current_setting('app.rls_bypass', true) = 'maintenance') WITH CHECK (current_setting('app.rls_bypass', true) = 'maintenance');
