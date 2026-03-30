DO $$ BEGIN CREATE TYPE "entity_type" AS ENUM ('person', 'company', 'project', 'product', 'channel', 'technology', 'concept', 'location'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$
DECLARE
  _group record;
  _survivor_id uuid;
  _dup_ids uuid[];
BEGIN
  -- Deduplicate entities that would collide on the unique index
  -- (workspace_id, type='concept', lower(canonical_name)) after converting
  -- non-standard types to 'concept'. The set of entities that will be
  -- type='concept' after the UPDATE includes both existing 'concept' entities
  -- and non-standard-type entities being converted.
  FOR _group IN
    SELECT workspace_id AS ws, lower(canonical_name) AS canon
    FROM entities
    WHERE type NOT IN ('person','company','project','product','channel','technology','location')
    GROUP BY workspace_id, lower(canonical_name)
    HAVING COUNT(*) > 1
  LOOP
    -- Prefer keeping an existing 'concept' entity, then oldest by created_at
    SELECT id INTO _survivor_id
    FROM entities
    WHERE workspace_id = _group.ws
      AND lower(canonical_name) = _group.canon
      AND type NOT IN ('person','company','project','product','channel','technology','location')
    ORDER BY (type = 'concept') DESC, created_at ASC
    LIMIT 1;

    SELECT array_agg(id) INTO _dup_ids
    FROM entities
    WHERE workspace_id = _group.ws
      AND lower(canonical_name) = _group.canon
      AND type NOT IN ('person','company','project','product','channel','technology','location')
      AND id != _survivor_id;

    -- Re-point foreign keys from duplicates to the survivor
    UPDATE users SET entity_id = _survivor_id
    WHERE entity_id = ANY(_dup_ids);

    UPDATE memory_entities SET entity_id = _survivor_id
    WHERE entity_id = ANY(_dup_ids)
      AND NOT EXISTS (
        SELECT 1 FROM memory_entities me2
        WHERE me2.memory_id = memory_entities.memory_id AND me2.entity_id = _survivor_id
      );
    DELETE FROM memory_entities WHERE entity_id = ANY(_dup_ids);

    UPDATE entity_aliases SET entity_id = _survivor_id
    WHERE entity_id = ANY(_dup_ids)
      AND NOT EXISTS (
        SELECT 1 FROM entity_aliases ea2
        WHERE ea2.alias_lower = entity_aliases.alias_lower AND ea2.entity_id = _survivor_id
      );
    DELETE FROM entity_aliases WHERE entity_id = ANY(_dup_ids);

    DELETE FROM entities WHERE id = ANY(_dup_ids);
  END LOOP;
END $$;--> statement-breakpoint
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
