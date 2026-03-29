DO $$ BEGIN CREATE TYPE "entity_type" AS ENUM ('person', 'company', 'project', 'product', 'channel', 'technology', 'concept', 'location'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
UPDATE "entities" SET "type" = 'concept' WHERE "type" NOT IN ('person', 'company', 'project', 'product', 'channel', 'technology', 'concept', 'location');--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "type" TYPE "entity_type" USING "type"::"entity_type";--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "memory_entity_role" AS ENUM ('subject', 'object', 'mentioned'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
UPDATE "memory_entities" SET "role" = 'mentioned' WHERE "role" IS NULL OR "role" NOT IN ('subject', 'object', 'mentioned');--> statement-breakpoint
ALTER TABLE "memory_entities" ALTER COLUMN "role" TYPE "memory_entity_role" USING "role"::"memory_entity_role";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
