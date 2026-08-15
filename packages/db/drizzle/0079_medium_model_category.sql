ALTER TYPE "model_catalog_category" ADD VALUE IF NOT EXISTS 'medium';--> statement-breakpoint
INSERT INTO "model_catalog_selections" ("workspace_id", "model_id", "category", "enabled", "is_default")
VALUES ('default', 'anthropic/claude-sonnet-5', 'medium', true, true)
ON CONFLICT DO NOTHING;
