DO $$ BEGIN CREATE TYPE "entity_type" AS ENUM ('person', 'company', 'project', 'product', 'channel', 'technology', 'concept', 'location'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
UPDATE "entities" SET "type" = 'concept' WHERE "type" NOT IN ('person', 'company', 'project', 'product', 'channel', 'technology', 'concept', 'location');--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='entities' AND column_name='type' AND data_type='text') THEN
    ALTER TABLE "entities" ALTER COLUMN "type" DROP DEFAULT;
    ALTER TABLE "entities" ALTER COLUMN "type" TYPE "entity_type" USING "type"::"entity_type";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "memory_entity_role" AS ENUM ('subject', 'object', 'mentioned'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
UPDATE "memory_entities" SET "role" = 'mentioned' WHERE "role" IS NULL OR "role" NOT IN ('subject', 'object', 'mentioned');--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memory_entities' AND column_name='role' AND data_type='text') THEN
    ALTER TABLE "memory_entities" ALTER COLUMN "role" DROP DEFAULT;
    ALTER TABLE "memory_entities" ALTER COLUMN "role" TYPE "memory_entity_role" USING "role"::"memory_entity_role";
    ALTER TABLE "memory_entities" ALTER COLUMN "role" SET DEFAULT 'mentioned'::"memory_entity_role";
  END IF;
END $$;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
