-- #911: retire users.known_facts in favour of entities.summary / entities.metadata.
--
-- Additive only — NO destructive DDL, NO data deletion. The column is kept
-- (frozen, no longer written) for a soak period; a separate drop migration
-- follows once the soak confirms nothing still depends on it.
--
-- Backfill semantics (exact rows touched):
--   Statement 2 touches `entities` rows that are linked from `users.entity_id`
--     where users.known_facts->>'team' (or ->>'role') is non-empty AND the
--     entity's metadata does not already carry that key. It merges the value
--     into entities.metadata (keys: 'team', 'role').
--   Statement 3 touches `entities` rows linked from `users.entity_id` where
--     known_facts contains at least one value (role/team/interests/
--     personalDetails/preferences) that is NOT already present in the entity's
--     summary (case-insensitive substring check), and the summary does not
--     already contain the "Migrated legacy profile facts (#911)" marker
--     (idempotency guard). It APPENDS a marked paragraph; existing summary
--     text is never modified or removed.
--   Users without a linked entity (entity_id IS NULL) are untouched — their
--     known_facts remain frozen in the column and nothing is lost.
--
-- Reversal:
--   Statement 2: remove the merged keys —
--     UPDATE entities SET metadata = metadata - 'team' - 'role' WHERE ...;
--     (only if they were absent before; see PR description for the exact scope)
--   Statement 3: strip the appended paragraph —
--     UPDATE entities SET summary = NULLIF(regexp_replace(summary,
--       '(\n\n)?Migrated legacy profile facts \(#911\): [^\n]*', ''), '')
--     WHERE summary LIKE '%Migrated legacy profile facts (#911)%';
COMMENT ON COLUMN "users"."known_facts" IS 'DEPRECATED (#911): frozen, no longer written. entities.summary (prose) and entities.metadata (structured team/role) are the source of truth for human profiles. Kept for a soak period; a separate drop migration follows.';--> statement-breakpoint
UPDATE "entities" e
SET "metadata" = COALESCE(e."metadata", '{}'::jsonb)
    || CASE WHEN COALESCE(e."metadata"->>'team', '') = '' AND COALESCE(u."known_facts"->>'team', '') <> ''
         THEN jsonb_build_object('team', u."known_facts"->>'team') ELSE '{}'::jsonb END
    || CASE WHEN COALESCE(e."metadata"->>'role', '') = '' AND COALESCE(u."known_facts"->>'role', '') <> ''
         THEN jsonb_build_object('role', u."known_facts"->>'role') ELSE '{}'::jsonb END,
    "updated_at" = now()
FROM "users" u
WHERE u."entity_id" = e."id"
  AND u."known_facts" IS NOT NULL
  AND (
    (COALESCE(e."metadata"->>'team', '') = '' AND COALESCE(u."known_facts"->>'team', '') <> '')
    OR (COALESCE(e."metadata"->>'role', '') = '' AND COALESCE(u."known_facts"->>'role', '') <> '')
  );--> statement-breakpoint
UPDATE "entities" e
SET "summary" = CASE
      WHEN COALESCE(e."summary", '') = '' THEN 'Migrated legacy profile facts (#911): ' || fx.block
      ELSE e."summary" || E'\n\n' || 'Migrated legacy profile facts (#911): ' || fx.block
    END,
    "updated_at" = now()
FROM (
  SELECT u."entity_id" AS entity_id,
         string_agg(f.fact, '; ' ORDER BY f.ord, f.fact) AS block
  FROM "users" u
  JOIN "entities" e2 ON e2."id" = u."entity_id"
  CROSS JOIN LATERAL (
    SELECT 1 AS ord, 'Role: ' || (u."known_facts"->>'role') AS fact, u."known_facts"->>'role' AS val
      WHERE COALESCE(u."known_facts"->>'role', '') <> ''
    UNION ALL
    SELECT 2, 'Team: ' || (u."known_facts"->>'team'), u."known_facts"->>'team'
      WHERE COALESCE(u."known_facts"->>'team', '') <> ''
    UNION ALL
    SELECT 3, 'Interest: ' || i.value, i.value
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(u."known_facts"->'interests') = 'array' THEN u."known_facts"->'interests' ELSE '[]'::jsonb END) i
      WHERE COALESCE(i.value, '') <> ''
    UNION ALL
    SELECT 4, 'Personal detail: ' || d.value, d.value
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(u."known_facts"->'personalDetails') = 'array' THEN u."known_facts"->'personalDetails' ELSE '[]'::jsonb END) d
      WHERE COALESCE(d.value, '') <> ''
    UNION ALL
    SELECT 5, 'Preference: ' || pr.value, pr.value
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(u."known_facts"->'preferences') = 'array' THEN u."known_facts"->'preferences' ELSE '[]'::jsonb END) pr
      WHERE COALESCE(pr.value, '') <> ''
  ) f
  WHERE u."known_facts" IS NOT NULL
    AND position(lower(f.val) IN lower(COALESCE(e2."summary", ''))) = 0
  GROUP BY u."entity_id"
) fx
WHERE e."id" = fx.entity_id
  AND position('Migrated legacy profile facts (#911)' IN COALESCE(e."summary", '')) = 0;
