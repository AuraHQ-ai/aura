ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "capabilities" jsonb DEFAULT NULL;--> statement-breakpoint

UPDATE "model_catalog"
SET
  "capabilities" = jsonb_build_object('provider', 'anthropic', 'thinkingMode', 'enabled'),
  "updated_at" = now()
WHERE (
    "model_id" ~ '^anthropic/claude-opus-4\.[0-6]$'
    OR "model_id" LIKE 'anthropic/claude-sonnet-%'
  )
  AND "capabilities" IS NULL;--> statement-breakpoint

UPDATE "model_catalog"
SET
  "capabilities" = jsonb_build_object('provider', 'anthropic', 'thinkingMode', 'adaptive'),
  "updated_at" = now()
WHERE "model_id" IN ('anthropic/claude-opus-4.7', 'anthropic/claude-opus-4.8')
  AND "capabilities" IS NULL;--> statement-breakpoint

UPDATE "model_catalog"
SET
  "capabilities" = jsonb_build_object('provider', 'openai', 'reasoningEffort', 'medium'),
  "updated_at" = now()
WHERE (
    "model_id" LIKE 'openai/gpt-5%'
    OR "model_id" LIKE 'openai/o%'
  )
  AND "capabilities" IS NULL;--> statement-breakpoint

UPDATE "model_catalog"
SET
  "capabilities" = jsonb_build_object('provider', 'google', 'thinkingBudget', 'dynamic'),
  "updated_at" = now()
WHERE "model_id" LIKE 'google/gemini-2.5%'
  AND "capabilities" IS NULL;--> statement-breakpoint

UPDATE "model_catalog"
SET
  "capabilities" = jsonb_build_object('provider', 'xai', 'reasoningEffort', 'low'),
  "updated_at" = now()
WHERE "model_id" LIKE 'xai/grok-%'
  AND "capabilities" IS NULL
  AND (
    "tags" ? 'reasoning'
    OR "model_id" LIKE '%reasoning%'
  );
