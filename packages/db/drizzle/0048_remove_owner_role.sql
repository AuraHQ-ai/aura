-- Migrate owner role to admin (owner role is being removed; admin is now the highest role)
UPDATE user_profiles SET role = 'admin', updated_at = NOW() WHERE role = 'owner';--> statement-breakpoint
-- Migrate any credentials using per_user scope to owner scope (per_user is being removed)
UPDATE credentials SET scope = 'owner', updated_at = NOW() WHERE scope = 'per_user';
