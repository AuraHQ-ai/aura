ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'semantic';--> statement-breakpoint
ALTER TYPE "memory_type" ADD VALUE IF NOT EXISTS 'preference';--> statement-breakpoint
ALTER TYPE "memory_type" ADD VALUE IF NOT EXISTS 'event';--> statement-breakpoint
ALTER TYPE "memory_type" ADD VALUE IF NOT EXISTS 'insight';
