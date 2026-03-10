-- Add auth_scheme column with safe default (idempotent)
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "auth_scheme" text NOT NULL DEFAULT 'bearer';
--> statement-breakpoint
-- Migrate existing rows (keep old columns until JS migration completes)
UPDATE "credentials" SET "auth_scheme" = 'oauth_client' WHERE "type" = 'oauth_client';
--> statement-breakpoint
UPDATE "credentials" SET "auth_scheme" = 'bearer' WHERE "type" = 'token';
--> statement-breakpoint
-- Add check constraint (idempotent guard)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credentials_auth_scheme_check'
      AND conrelid = 'credentials'::regclass
  ) THEN
    ALTER TABLE "credentials"
      ADD CONSTRAINT "credentials_auth_scheme_check"
      CHECK ("auth_scheme" IN ('bearer','basic','header','query','oauth_client'));
  END IF;
END $$;
