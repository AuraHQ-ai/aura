ALTER TABLE "memories" ADD COLUMN "linked_memory_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
