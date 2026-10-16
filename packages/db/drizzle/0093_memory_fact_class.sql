DO $$ BEGIN
  CREATE TYPE "memory_fact_class" AS ENUM('access', 'permissions', 'pricing', 'url', 'tool_status');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "fact_class" "memory_fact_class";--> statement-breakpoint
CREATE INDEX "memories_fact_class_idx" ON "memories" USING btree ("fact_class");
