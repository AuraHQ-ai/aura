-- Multi-tenancy Phase 0 (issue #1393, part of #17): add workspace_id to the
-- 4 tables that were missing it: entity_aliases, memory_entities, resources,
-- voice_calls. Mirrors the pattern of 0043_add_workspace_id.sql:
--   1. ADD COLUMN with DEFAULT 'default' (nullable first, so concurrent
--      inserts from old code never produce NULLs)
--   2. UPDATE-backfill existing rows to 'default'
--   3. SET NOT NULL only after the backfill
--   4. FK to workspaces(id)
--   5. Swap single-column unique indexes for workspace-first composites
--
-- NO BEHAVIOUR CHANGE: every existing and new row lands on workspace
-- 'default' via the column DEFAULT, exactly like the other 36 tenant tables.

-- 0. Ensure the default workspace row exists (0043 seeded it; defensive re-seed
--    so the FK adds below can never fail on a fresh database)
INSERT INTO "workspaces" ("id", "name") VALUES ('default', 'Default') ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 1. entity_aliases ----------------------------------------------------------
ALTER TABLE "entity_aliases" ADD COLUMN IF NOT EXISTS "workspace_id" text DEFAULT 'default';--> statement-breakpoint
UPDATE "entity_aliases" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "entity_aliases" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
UPDATE "entity_aliases" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "entity_aliases" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_aliases" DROP CONSTRAINT IF EXISTS "entity_aliases_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "entity_aliases_lower_entity_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_aliases_workspace_lower_entity_idx" ON "entity_aliases" USING btree ("workspace_id", "alias_lower", "entity_id");--> statement-breakpoint

-- 2. memory_entities ---------------------------------------------------------
-- PK stays (memory_id, entity_id): both sides are globally-unique uuids, so a
-- workspace-first PK adds nothing. The column exists for RLS enforcement.
ALTER TABLE "memory_entities" ADD COLUMN IF NOT EXISTS "workspace_id" text DEFAULT 'default';--> statement-breakpoint
UPDATE "memory_entities" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "memory_entities" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
UPDATE "memory_entities" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "memory_entities" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_entities" DROP CONSTRAINT IF EXISTS "memory_entities_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 3. resources ----------------------------------------------------------------
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "workspace_id" text DEFAULT 'default';--> statement-breakpoint
UPDATE "resources" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "resources" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
UPDATE "resources" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "resources" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" DROP CONSTRAINT IF EXISTS "resources_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "resources_url_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resources_workspace_url_idx" ON "resources" USING btree ("workspace_id", "url");--> statement-breakpoint

-- 4. voice_calls ---------------------------------------------------------------
ALTER TABLE "voice_calls" ADD COLUMN IF NOT EXISTS "workspace_id" text DEFAULT 'default';--> statement-breakpoint
UPDATE "voice_calls" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "voice_calls" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
UPDATE "voice_calls" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "voice_calls" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_calls" DROP CONSTRAINT IF EXISTS "voice_calls_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" DROP CONSTRAINT IF EXISTS "voice_calls_conversation_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_calls_workspace_conversation_id_idx" ON "voice_calls" USING btree ("workspace_id", "conversation_id");--> statement-breakpoint

-- 5. approval_items --------------------------------------------------------
-- Orphan of the pre-0049 governance system: `0049_remove_governance_tables`
-- dropped `approvals` / `approval_policies` but never listed `approval_items`,
-- so it survives on the production database (0 rows) while existing in no
-- migration and not in schema.ts. It is NOT recreated here — the whole block
-- is guarded so it only runs where the table actually exists (prod), and the
-- fresh-database replay used by the isolation test stays faithful to the
-- journal. Covered now so RLS (0091) can fence it before it ever grows rows.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'approval_items'
  ) THEN
    ALTER TABLE "approval_items" ADD COLUMN IF NOT EXISTS "workspace_id" text DEFAULT 'default';
    UPDATE "approval_items" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
    ALTER TABLE "approval_items" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
    ALTER TABLE "approval_items" ALTER COLUMN "workspace_id" SET NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'approval_items_workspace_id_workspaces_id_fk'
    ) THEN
      ALTER TABLE "approval_items"
        ADD CONSTRAINT "approval_items_workspace_id_workspaces_id_fk"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");
    END IF;
  END IF;
END $$;
