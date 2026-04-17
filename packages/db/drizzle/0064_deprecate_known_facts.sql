-- Retire users.known_facts: unified profile v2 builds profile prose from entities.summary.
-- Kept as a column for rollback safety, but constrained to stay empty so future code
-- cannot silently re-introduce it as a parallel profile source.
COMMENT ON COLUMN "users"."known_facts" IS 'DEPRECATED: retired by unified profile v2. Kept temporarily for rollback safety; do not read/write in runtime context paths.';

-- Null out any pre-existing prose so the deprecation is real, not theoretical.
UPDATE "users"
SET "known_facts" = '{}'::jsonb
WHERE "known_facts" IS NOT NULL AND "known_facts" <> '{}'::jsonb;

-- Lockout: new writes must be empty object. Prevents future regressions.
ALTER TABLE "users"
  ADD CONSTRAINT "users_known_facts_deprecated_empty"
  CHECK (
    "known_facts" IS NULL
    OR "known_facts" = '{}'::jsonb
  );
