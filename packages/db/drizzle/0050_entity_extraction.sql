-- Enable pg_trgm extension for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- Create entities table
CREATE TABLE "entities" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id"),
  "type" TEXT NOT NULL,
  "canonical_name" TEXT NOT NULL,
  "description" TEXT,
  "slack_user_id" TEXT,
  "metadata" JSONB DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "entities_type_canonical_idx" ON "entities" ("workspace_id", "type", lower("canonical_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "entities_slack_user_idx" ON "entities" ("workspace_id", "slack_user_id") WHERE "slack_user_id" IS NOT NULL;--> statement-breakpoint

-- Create entity_aliases table
CREATE TABLE "entity_aliases" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id" UUID NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "alias" TEXT NOT NULL,
  "alias_lower" TEXT GENERATED ALWAYS AS (lower("alias")) STORED,
  "source" TEXT DEFAULT 'extracted',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_lower_entity_idx" ON "entity_aliases" ("alias_lower", "entity_id");--> statement-breakpoint
CREATE INDEX "entity_aliases_trgm_idx" ON "entity_aliases" USING gin ("alias_lower" gin_trgm_ops);--> statement-breakpoint

-- Create memory_entities junction table
CREATE TABLE "memory_entities" (
  "memory_id" UUID NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "entity_id" UUID NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "role" TEXT DEFAULT 'mentioned',
  PRIMARY KEY ("memory_id", "entity_id")
);--> statement-breakpoint
CREATE INDEX "memory_entities_entity_idx" ON "memory_entities" ("entity_id");--> statement-breakpoint

-- Add new columns to user_profiles (merging from people)
ALTER TABLE "user_profiles" ADD COLUMN "job_title" TEXT;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "gender" TEXT;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "preferred_language" TEXT DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "birthdate" DATE;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "manager_id" TEXT;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "notes" TEXT;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "entity_id" UUID REFERENCES "entities"("id");--> statement-breakpoint

-- Copy data from people into user_profiles
UPDATE "user_profiles" up
SET
  "job_title" = p."job_title",
  "gender" = p."gender",
  "preferred_language" = p."preferred_language",
  "birthdate" = p."birthdate",
  "manager_id" = (SELECT pp."slack_user_id" FROM "people" pp WHERE pp."id" = p."manager_id"),
  "notes" = p."notes"
FROM "people" p
WHERE p."slack_user_id" = up."slack_user_id";--> statement-breakpoint

-- Add user_id column to addresses (new FK to user_profiles)
ALTER TABLE "addresses" ADD COLUMN "user_id" UUID REFERENCES "user_profiles"("id");--> statement-breakpoint

-- Populate addresses.user_id from the existing people→user_profiles link
UPDATE "addresses" a SET "user_id" = up."id"
FROM "user_profiles" up
JOIN "people" p ON up."person_id" = p."id"
WHERE a."person_id" = p."id";--> statement-breakpoint

-- Make addresses.person_id nullable (keep for safety, don't drop yet)
ALTER TABLE "addresses" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint

-- Rename user_profiles to users
ALTER TABLE "user_profiles" RENAME TO "users";--> statement-breakpoint

-- Seed entities from existing users
INSERT INTO "entities" ("workspace_id", "type", "canonical_name", "slack_user_id")
SELECT "workspace_id", 'person', "display_name", "slack_user_id"
FROM "users"
WHERE "slack_user_id" IS NOT NULL;--> statement-breakpoint

-- Link users to their entities
UPDATE "users" u SET "entity_id" = e."id"
FROM "entities" e WHERE e."slack_user_id" = u."slack_user_id";--> statement-breakpoint

-- Seed initial aliases from display names
INSERT INTO "entity_aliases" ("entity_id", "alias", "source")
SELECT e."id", u."display_name", 'slack_profile'
FROM "users" u JOIN "entities" e ON e."slack_user_id" = u."slack_user_id"
WHERE u."display_name" IS NOT NULL;--> statement-breakpoint

-- Drop people table (addresses FK is now via user_id)
DROP TABLE IF EXISTS "people" CASCADE;
