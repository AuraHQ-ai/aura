DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_status') THEN
    CREATE TYPE memory_status AS ENUM ('current', 'superseded', 'disputed', 'archived', 'deleted');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'status') THEN
    ALTER TABLE memories ADD COLUMN status memory_status NOT NULL DEFAULT 'current';
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'confidence') THEN
    ALTER TABLE memories ADD COLUMN confidence real DEFAULT 0.8;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'valid_from') THEN
    ALTER TABLE memories ADD COLUMN valid_from timestamptz;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'valid_until') THEN
    ALTER TABLE memories ADD COLUMN valid_until timestamptz;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'supersedes_memory_id') THEN
    ALTER TABLE memories ADD COLUMN supersedes_memory_id uuid REFERENCES memories(id);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'superseded_at') THEN
    ALTER TABLE memories ADD COLUMN superseded_at timestamptz;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'superseded_by_memory_id') THEN
    ALTER TABLE memories ADD COLUMN superseded_by_memory_id uuid REFERENCES memories(id);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories (valid_from);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories (supersedes_memory_id) WHERE supersedes_memory_id IS NOT NULL;--> statement-breakpoint
UPDATE memories SET status = 'superseded' WHERE relevance_score <= 0.001 AND status = 'current';--> statement-breakpoint
UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
