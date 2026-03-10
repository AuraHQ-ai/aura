-- Extend auth_scheme check constraint to include google_service_account
ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_auth_scheme_check";
--> statement-breakpoint
ALTER TABLE "credentials"
  ADD CONSTRAINT "credentials_auth_scheme_check"
  CHECK ("auth_scheme" IN ('bearer','basic','header','query','oauth_client','google_service_account'));
