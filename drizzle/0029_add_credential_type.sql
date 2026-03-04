ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'token';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credentials_type_check'
  ) THEN
    ALTER TABLE "credentials" ADD CONSTRAINT "credentials_type_check" CHECK (type IN ('token', 'oauth_client'));
  END IF;
END $$;
