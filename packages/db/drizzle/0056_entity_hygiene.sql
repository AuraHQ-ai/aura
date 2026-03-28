CREATE TYPE "entity_type" AS ENUM ('person', 'company', 'project', 'product', 'channel', 'technology', 'concept', 'location');--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "type" TYPE "entity_type" USING "type"::"entity_type";--> statement-breakpoint
CREATE TYPE "memory_entity_role" AS ENUM ('subject', 'object', 'mentioned');--> statement-breakpoint
ALTER TABLE "memory_entities" ALTER COLUMN "role" TYPE "memory_entity_role" USING "role"::"memory_entity_role";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_aliases_trgm" ON "entity_aliases" USING gin ("alias_lower" gin_trgm_ops);
