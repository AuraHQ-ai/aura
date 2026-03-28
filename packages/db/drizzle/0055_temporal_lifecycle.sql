CREATE TYPE memory_status AS ENUM ('current', 'superseded', 'disputed', 'archived', 'deleted');--> statement-breakpoint
ALTER TABLE memories ADD COLUMN status memory_status NOT NULL DEFAULT 'current';--> statement-breakpoint
ALTER TABLE memories ADD COLUMN confidence real DEFAULT 0.8;--> statement-breakpoint
ALTER TABLE memories ADD COLUMN valid_from timestamptz;--> statement-breakpoint
ALTER TABLE memories ADD COLUMN valid_until timestamptz;--> statement-breakpoint
ALTER TABLE memories ADD COLUMN supersedes_memory_id uuid REFERENCES memories(id);--> statement-breakpoint
ALTER TABLE memories ADD COLUMN superseded_at timestamptz;--> statement-breakpoint
ALTER TABLE memories ADD COLUMN superseded_by_memory_id uuid REFERENCES memories(id);--> statement-breakpoint
CREATE INDEX idx_memories_status ON memories (status);--> statement-breakpoint
CREATE INDEX idx_memories_valid_from ON memories (valid_from);--> statement-breakpoint
CREATE INDEX idx_memories_supersedes ON memories (supersedes_memory_id) WHERE supersedes_memory_id IS NOT NULL;--> statement-breakpoint
UPDATE memories SET status = 'superseded' WHERE relevance_score <= 0.001;--> statement-breakpoint
UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
