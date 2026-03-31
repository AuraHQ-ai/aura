-- Memory taxonomy simplification: collapse 9 types to 5
-- personal -> fact, relationship -> fact, sentiment -> fact, insight -> fact

-- Step 1: Migrate existing memories to new types
UPDATE memories SET type = 'fact' WHERE type IN ('personal', 'relationship', 'sentiment', 'insight');

-->statement-breakpoint

-- Step 2: Recreate the enum with only the 5 types
-- PG doesn't support DROP VALUE from enum, so we need to recreate
ALTER TABLE memories ALTER COLUMN type TYPE text;

-->statement-breakpoint

DROP TYPE IF EXISTS memory_type;

-->statement-breakpoint

CREATE TYPE memory_type AS ENUM ('fact', 'decision', 'preference', 'event', 'open_thread');

-->statement-breakpoint

ALTER TABLE memories ALTER COLUMN type TYPE memory_type USING type::memory_type;
