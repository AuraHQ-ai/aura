UPDATE "conversation_traces"
SET "model_id" = CASE
  WHEN "model_id" = 'xai/grok-4.20-reasoning-beta' THEN 'xai/grok-4.20-reasoning'
  WHEN "model_id" = 'xai/grok-4.20-non-reasoning-beta' THEN 'xai/grok-4.20-non-reasoning'
  ELSE "model_id"
END
WHERE "model_id" IN ('xai/grok-4.20-reasoning-beta', 'xai/grok-4.20-non-reasoning-beta');--> statement-breakpoint

UPDATE "conversation_messages"
SET "model_id" = CASE
  WHEN "model_id" = 'xai/grok-4.20-reasoning-beta' THEN 'xai/grok-4.20-reasoning'
  WHEN "model_id" = 'xai/grok-4.20-non-reasoning-beta' THEN 'xai/grok-4.20-non-reasoning'
  ELSE "model_id"
END
WHERE "model_id" IN ('xai/grok-4.20-reasoning-beta', 'xai/grok-4.20-non-reasoning-beta');--> statement-breakpoint

UPDATE "messages"
SET "model" = CASE
  WHEN "model" = 'xai/grok-4.20-reasoning-beta' THEN 'xai/grok-4.20-reasoning'
  WHEN "model" = 'xai/grok-4.20-non-reasoning-beta' THEN 'xai/grok-4.20-non-reasoning'
  ELSE "model"
END
WHERE "model" IN ('xai/grok-4.20-reasoning-beta', 'xai/grok-4.20-non-reasoning-beta');--> statement-breakpoint

UPDATE "settings"
SET
  "value" = CASE
    WHEN "value" = 'xai/grok-4.20-reasoning-beta' THEN 'xai/grok-4.20-reasoning'
    WHEN "value" = 'xai/grok-4.20-non-reasoning-beta' THEN 'xai/grok-4.20-non-reasoning'
    ELSE "value"
  END,
  "updated_at" = now()
WHERE "key" IN ('model_main', 'model_fast', 'model_embedding', 'model_escalation')
  AND "value" IN ('xai/grok-4.20-reasoning-beta', 'xai/grok-4.20-non-reasoning-beta');--> statement-breakpoint

WITH moved AS (
  DELETE FROM "model_catalog_selections"
  WHERE "model_id" = 'xai/grok-4.20-reasoning-beta'
  RETURNING "workspace_id", "category", "enabled", "is_default", "created_at"
)
INSERT INTO "model_catalog_selections" ("workspace_id", "model_id", "category", "enabled", "is_default", "created_at", "updated_at")
SELECT
  "workspace_id",
  'xai/grok-4.20-reasoning',
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
  WHERE "model_id" = 'xai/grok-4.20-non-reasoning-beta'
  RETURNING "workspace_id", "category", "enabled", "is_default", "created_at"
)
INSERT INTO "model_catalog_selections" ("workspace_id", "model_id", "category", "enabled", "is_default", "created_at", "updated_at")
SELECT
  "workspace_id",
  'xai/grok-4.20-non-reasoning',
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

INSERT INTO "model_catalog" ("workspace_id", "model_id", "provider", "name", "type", "context_window", "max_tokens", "last_synced_at", "updated_at")
VALUES
  ('default', 'xai/grok-4.20-reasoning', 'xai', 'Grok 4.20 Reasoning', 'language', 2000000, 2000000, now(), now()),
  ('default', 'xai/grok-4.20-non-reasoning', 'xai', 'Grok 4.20 Non-Reasoning', 'language', 2000000, 2000000, now(), now()),
  ('default', 'xai/grok-4.20-multi-agent', 'xai', 'Grok 4.20 Multi-Agent', 'language', 2000000, 2000000, now(), now())
ON CONFLICT ("workspace_id", "model_id") DO UPDATE
SET
  "provider" = EXCLUDED."provider",
  "name" = EXCLUDED."name",
  "type" = EXCLUDED."type",
  "context_window" = EXCLUDED."context_window",
  "max_tokens" = EXCLUDED."max_tokens",
  "last_synced_at" = now(),
  "updated_at" = now();--> statement-breakpoint

INSERT INTO "model_catalog_selections" ("workspace_id", "model_id", "category", "enabled", "is_default", "created_at", "updated_at")
VALUES
  ('default', 'xai/grok-4.20-reasoning', 'main', true, false, now(), now()),
  ('default', 'xai/grok-4.20-multi-agent', 'main', true, false, now(), now()),
  ('default', 'xai/grok-4.20-non-reasoning', 'fast', true, false, now(), now())
ON CONFLICT ("workspace_id", "model_id", "category") DO UPDATE
SET
  "enabled" = EXCLUDED."enabled",
  "is_default" = EXCLUDED."is_default",
  "updated_at" = now();--> statement-breakpoint

UPDATE "model_catalog" mc
SET
  "model_id" = CASE
    WHEN mc."model_id" = 'xai/grok-4.20-reasoning-beta' THEN 'xai/grok-4.20-reasoning'
    WHEN mc."model_id" = 'xai/grok-4.20-non-reasoning-beta' THEN 'xai/grok-4.20-non-reasoning'
    ELSE mc."model_id"
  END,
  "name" = CASE
    WHEN mc."model_id" = 'xai/grok-4.20-reasoning-beta' THEN 'Grok 4.20 Reasoning'
    WHEN mc."model_id" = 'xai/grok-4.20-non-reasoning-beta' THEN 'Grok 4.20 Non-Reasoning'
    ELSE mc."name"
  END,
  "context_window" = 2000000,
  "max_tokens" = 2000000,
  "updated_at" = now()
WHERE mc."model_id" IN ('xai/grok-4.20-reasoning-beta', 'xai/grok-4.20-non-reasoning-beta')
  AND NOT EXISTS (
    SELECT 1
    FROM "model_catalog" mc2
    WHERE mc2."workspace_id" = mc."workspace_id"
      AND mc2."model_id" = CASE
        WHEN mc."model_id" = 'xai/grok-4.20-reasoning-beta' THEN 'xai/grok-4.20-reasoning'
        WHEN mc."model_id" = 'xai/grok-4.20-non-reasoning-beta' THEN 'xai/grok-4.20-non-reasoning'
      END
  );--> statement-breakpoint

DELETE FROM "model_catalog" mc
WHERE mc."model_id" IN ('xai/grok-4.20-reasoning-beta', 'xai/grok-4.20-non-reasoning-beta')
  AND EXISTS (
    SELECT 1
    FROM "model_catalog" mc2
    WHERE mc2."workspace_id" = mc."workspace_id"
      AND mc2."model_id" = CASE
        WHEN mc."model_id" = 'xai/grok-4.20-reasoning-beta' THEN 'xai/grok-4.20-reasoning'
        WHEN mc."model_id" = 'xai/grok-4.20-non-reasoning-beta' THEN 'xai/grok-4.20-non-reasoning'
      END
  );
