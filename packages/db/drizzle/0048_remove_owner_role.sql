-- Migrate owner role to admin (owner role is being removed; admin is now the highest role)
UPDATE user_profiles SET role = 'admin', updated_at = NOW() WHERE role = 'owner';--> statement-breakpoint
-- Existing owner-scoped credentials meant "requires owner role (level 3)"; remap to admin (now highest role)
UPDATE credentials SET scope = 'admin', updated_at = NOW() WHERE scope = 'owner';--> statement-breakpoint
-- Migrate per_user scope to owner scope (owner now means "only the credential's ownerId matches")
UPDATE credentials SET scope = 'owner', updated_at = NOW() WHERE scope = 'per_user';--> statement-breakpoint
-- Update CHECK constraint to remove per_user (no longer a valid scope)
ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_scope_check";--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_scope_check" CHECK ("credentials"."scope" IN ('member', 'power_user', 'admin', 'owner'));
