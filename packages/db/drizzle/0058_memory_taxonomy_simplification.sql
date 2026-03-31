UPDATE memories SET type = 'fact' WHERE type IN ('personal', 'relationship', 'sentiment', 'insight');--> statement-breakpoint
ALTER TABLE memories ALTER COLUMN type TYPE text;--> statement-breakpoint
DROP TYPE IF EXISTS memory_type;--> statement-breakpoint
CREATE TYPE memory_type AS ENUM ('fact', 'decision', 'preference', 'event', 'open_thread');--> statement-breakpoint
ALTER TABLE memories ALTER COLUMN type TYPE memory_type USING type::memory_type;
