UPDATE "conversation_traces"
SET "model_id" = CASE
  WHEN "model_id" = 'anthropic/claude-opus-4-6' THEN 'anthropic/claude-opus-4.6'
  WHEN "model_id" = 'anthropic/claude-haiku-4-5' THEN 'anthropic/claude-haiku-4.5'
  ELSE "model_id"
END
WHERE "model_id" IN ('anthropic/claude-opus-4-6', 'anthropic/claude-haiku-4-5');--> statement-breakpoint

UPDATE "conversation_messages"
SET "model_id" = CASE
  WHEN "model_id" = 'anthropic/claude-opus-4-6' THEN 'anthropic/claude-opus-4.6'
  WHEN "model_id" = 'anthropic/claude-haiku-4-5' THEN 'anthropic/claude-haiku-4.5'
  ELSE "model_id"
END
WHERE "model_id" IN ('anthropic/claude-opus-4-6', 'anthropic/claude-haiku-4-5');--> statement-breakpoint

UPDATE "messages"
SET "model" = CASE
  WHEN "model" = 'anthropic/claude-opus-4-6' THEN 'anthropic/claude-opus-4.6'
  WHEN "model" = 'anthropic/claude-haiku-4-5' THEN 'anthropic/claude-haiku-4.5'
  ELSE "model"
END
WHERE "model" IN ('anthropic/claude-opus-4-6', 'anthropic/claude-haiku-4-5');--> statement-breakpoint

UPDATE "settings"
SET
  "value" = CASE
    WHEN "value" = 'anthropic/claude-opus-4-6' THEN 'anthropic/claude-opus-4.6'
    WHEN "value" = 'anthropic/claude-haiku-4-5' THEN 'anthropic/claude-haiku-4.5'
    ELSE "value"
  END,
  "updated_at" = now()
WHERE "key" IN ('model_main', 'model_fast', 'model_embedding', 'model_escalation')
  AND "value" IN ('anthropic/claude-opus-4-6', 'anthropic/claude-haiku-4-5');--> statement-breakpoint

WITH moved AS (
  DELETE FROM "model_catalog_selections"
  WHERE "model_id" = 'anthropic/claude-opus-4-6'
  RETURNING "workspace_id", "category", "enabled", "is_default", "created_at"
)
INSERT INTO "model_catalog_selections" ("workspace_id", "model_id", "category", "enabled", "is_default", "created_at", "updated_at")
SELECT
  "workspace_id",
  'anthropic/claude-opus-4.6',
  "category",
  "enabled",
  "is_default",
  "created_at",
  now()
FROM moved
ON CONFLICT ("workspace_id", "model_id", "category") DO UPDATE
SET
  "enabled" = "model_catalog_selections"."enabled" OR EXCLUDED."enabled",
  "is_default" = "model_catalog_selections"."is_default" OR EXCLUDED."is_default",
  "updated_at" = now();--> statement-breakpoint

WITH moved AS (
  DELETE FROM "model_catalog_selections"
  WHERE "model_id" = 'anthropic/claude-haiku-4-5'
  RETURNING "workspace_id", "category", "enabled", "is_default", "created_at"
)
INSERT INTO "model_catalog_selections" ("workspace_id", "model_id", "category", "enabled", "is_default", "created_at", "updated_at")
SELECT
  "workspace_id",
  'anthropic/claude-haiku-4.5',
  "category",
  "enabled",
  "is_default",
  "created_at",
  now()
FROM moved
ON CONFLICT ("workspace_id", "model_id", "category") DO UPDATE
SET
  "enabled" = "model_catalog_selections"."enabled" OR EXCLUDED."enabled",
  "is_default" = "model_catalog_selections"."is_default" OR EXCLUDED."is_default",
  "updated_at" = now();--> statement-breakpoint

UPDATE "model_catalog" mc
SET
  "model_id" = CASE
    WHEN mc."model_id" = 'anthropic/claude-opus-4-6' THEN 'anthropic/claude-opus-4.6'
    WHEN mc."model_id" = 'anthropic/claude-haiku-4-5' THEN 'anthropic/claude-haiku-4.5'
    ELSE mc."model_id"
  END,
  "updated_at" = now()
WHERE mc."model_id" IN ('anthropic/claude-opus-4-6', 'anthropic/claude-haiku-4-5')
  AND NOT EXISTS (
    SELECT 1
    FROM "model_catalog" mc2
    WHERE mc2."workspace_id" = mc."workspace_id"
      AND mc2."model_id" = CASE
        WHEN mc."model_id" = 'anthropic/claude-opus-4-6' THEN 'anthropic/claude-opus-4.6'
        WHEN mc."model_id" = 'anthropic/claude-haiku-4-5' THEN 'anthropic/claude-haiku-4.5'
        ELSE mc."model_id"
      END
  );--> statement-breakpoint

DELETE FROM "model_catalog" mc
WHERE mc."model_id" IN ('anthropic/claude-opus-4-6', 'anthropic/claude-haiku-4-5')
  AND EXISTS (
    SELECT 1
    FROM "model_catalog" mc2
    WHERE mc2."workspace_id" = mc."workspace_id"
      AND mc2."model_id" = CASE
        WHEN mc."model_id" = 'anthropic/claude-opus-4-6' THEN 'anthropic/claude-opus-4.6'
        WHEN mc."model_id" = 'anthropic/claude-haiku-4-5' THEN 'anthropic/claude-haiku-4.5'
        ELSE mc."model_id"
      END
  );--> statement-breakpoint
