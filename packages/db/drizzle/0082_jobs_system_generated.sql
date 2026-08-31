ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "system_generated" boolean DEFAULT false NOT NULL;
