-- 0073 was edited in place (85b33b5) to add "user_message" after some DBs
-- (e.g. Neon preview branches) had already applied the original version.
-- Drizzle never re-runs an applied migration, so those DBs are missing the
-- column. Idempotent for DBs that ran the edited 0073.
ALTER TABLE "dashboard_chat_runs" ADD COLUMN IF NOT EXISTS "user_message" text;
