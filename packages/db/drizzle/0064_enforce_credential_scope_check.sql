DO $$
BEGIN
  ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_scope_check";
  ALTER TABLE "credentials" ADD CONSTRAINT "credentials_scope_check" CHECK ("scope" IN ('member', 'power_user', 'admin', 'owner', 'per_user'));
END $$;
