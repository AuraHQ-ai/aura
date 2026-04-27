DO $$ BEGIN
  CREATE TYPE "model_catalog_category" AS ENUM ('main', 'fast', 'embedding', 'escalation');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "model_catalog" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text DEFAULT 'default' NOT NULL,
  "model_id" text NOT NULL,
  "provider" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "type" text NOT NULL,
  "context_window" integer,
  "max_tokens" integer,
  "tags" jsonb,
  "raw_pricing" jsonb,
  "raw_payload" jsonb,
  "last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_catalog_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "model_catalog_workspace_model_id_idx" ON "model_catalog" USING btree ("workspace_id","model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_catalog_provider_idx" ON "model_catalog" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_catalog_type_idx" ON "model_catalog" USING btree ("type");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "model_catalog_selections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text DEFAULT 'default' NOT NULL,
  "model_id" text NOT NULL,
  "category" "model_catalog_category" NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_catalog_selections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "model_catalog_selections_workspace_model_category_idx" ON "model_catalog_selections" USING btree ("workspace_id","model_id","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_catalog_selections_category_idx" ON "model_catalog_selections" USING btree ("workspace_id","category","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_catalog_selections_default_idx" ON "model_catalog_selections" USING btree ("workspace_id","category") WHERE "is_default" = true;--> statement-breakpoint

ALTER TABLE "model_pricing" ALTER COLUMN "effective_from" TYPE timestamp with time zone USING "effective_from"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_pricing" ALTER COLUMN "effective_until" TYPE timestamp with time zone USING "effective_until"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_pricing" DROP CONSTRAINT IF EXISTS "model_pricing_token_type_check";--> statement-breakpoint

ALTER TABLE "conversation_traces" ADD COLUMN IF NOT EXISTS "cost_priced_at" timestamp with time zone;--> statement-breakpoint

INSERT INTO "model_catalog" ("workspace_id", "model_id", "provider", "name", "type")
VALUES
  ('default', 'anthropic/claude-opus-4-6', 'anthropic', 'Claude Opus 4.6', 'language'),
  ('default', 'anthropic/claude-sonnet-4-6', 'anthropic', 'Claude Sonnet 4.6', 'language'),
  ('default', 'anthropic/claude-sonnet-4-5', 'anthropic', 'Claude Sonnet 4.5', 'language'),
  ('default', 'anthropic/claude-sonnet-4-20250514', 'anthropic', 'Claude Sonnet 4', 'language'),
  ('default', 'openai/gpt-5.3-codex', 'openai', 'GPT-5.3 Codex', 'language'),
  ('default', 'openai/gpt-5.2', 'openai', 'GPT-5.2', 'language'),
  ('default', 'openai/gpt-5.1-thinking', 'openai', 'GPT-5.1 Thinking', 'language'),
  ('default', 'openai/gpt-4o', 'openai', 'GPT-4o', 'language'),
  ('default', 'google/gemini-3-pro-preview', 'google', 'Gemini 3 Pro', 'language'),
  ('default', 'google/gemini-2.5-pro', 'google', 'Gemini 2.5 Pro', 'language'),
  ('default', 'xai/grok-4.20-reasoning', 'xai', 'Grok 4.20 Reasoning', 'language'),
  ('default', 'xai/grok-4', 'xai', 'Grok 4', 'language'),
  ('default', 'xai/grok-4.1-fast-reasoning', 'xai', 'Grok 4.1 Fast', 'language'),
  ('default', 'xai/grok-4-fast-reasoning', 'xai', 'Grok 4 Fast', 'language'),
  ('default', 'deepseek/deepseek-v3.2-thinking', 'deepseek', 'DeepSeek V3.2 Thinking', 'language'),
  ('default', 'anthropic/claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'language'),
  ('default', 'openai/gpt-5.1-instant', 'openai', 'GPT-5.1 Instant', 'language'),
  ('default', 'openai/gpt-5-mini', 'openai', 'GPT-5 Mini', 'language'),
  ('default', 'openai/gpt-4o-mini', 'openai', 'GPT-4o Mini', 'language'),
  ('default', 'google/gemini-3-flash', 'google', 'Gemini 3 Flash', 'language'),
  ('default', 'google/gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', 'language'),
  ('default', 'xai/grok-4.20-non-reasoning', 'xai', 'Grok 4.20 Non-Reasoning', 'language'),
  ('default', 'xai/grok-4.20-multi-agent', 'xai', 'Grok 4.20 Multi-Agent', 'language'),
  ('default', 'xai/grok-4.1-fast-non-reasoning', 'xai', 'Grok 4.1 Fast NR', 'language'),
  ('default', 'xai/grok-4-fast-non-reasoning', 'xai', 'Grok 4 Fast NR', 'language'),
  ('default', 'xai/grok-code-fast-1', 'xai', 'Grok Code Fast 1', 'language'),
  ('default', 'deepseek/deepseek-v3.2', 'deepseek', 'DeepSeek V3.2', 'language'),
  ('default', 'openai/text-embedding-3-small', 'openai', 'OpenAI Embedding 3 Small (1536d)', 'embedding'),
  ('default', 'openai/text-embedding-3-large', 'openai', 'OpenAI Embedding 3 Large (3072d)', 'embedding'),
  ('default', 'google/text-embedding-005', 'google', 'Google Embedding 005', 'embedding')
ON CONFLICT ("workspace_id", "model_id") DO UPDATE
SET
  "provider" = EXCLUDED."provider",
  "name" = EXCLUDED."name",
  "type" = EXCLUDED."type",
  "updated_at" = now();--> statement-breakpoint

INSERT INTO "model_catalog_selections" ("workspace_id", "model_id", "category", "enabled", "is_default")
VALUES
  ('default', 'anthropic/claude-opus-4-6', 'main', true, false),
  ('default', 'anthropic/claude-sonnet-4-6', 'main', true, false),
  ('default', 'anthropic/claude-sonnet-4-5', 'main', true, false),
  ('default', 'anthropic/claude-sonnet-4-20250514', 'main', true, true),
  ('default', 'openai/gpt-5.3-codex', 'main', true, false),
  ('default', 'openai/gpt-5.2', 'main', true, false),
  ('default', 'openai/gpt-5.1-thinking', 'main', true, false),
  ('default', 'openai/gpt-4o', 'main', true, false),
  ('default', 'google/gemini-3-pro-preview', 'main', true, false),
  ('default', 'google/gemini-2.5-pro', 'main', true, false),
  ('default', 'xai/grok-4.20-reasoning', 'main', true, false),
  ('default', 'xai/grok-4.20-multi-agent', 'main', true, false),
  ('default', 'xai/grok-4', 'main', true, false),
  ('default', 'xai/grok-4.1-fast-reasoning', 'main', true, false),
  ('default', 'xai/grok-4-fast-reasoning', 'main', true, false),
  ('default', 'deepseek/deepseek-v3.2-thinking', 'main', true, false),
  ('default', 'anthropic/claude-haiku-4-5', 'fast', true, true),
  ('default', 'openai/gpt-5.1-instant', 'fast', true, false),
  ('default', 'openai/gpt-5-mini', 'fast', true, false),
  ('default', 'openai/gpt-4o-mini', 'fast', true, false),
  ('default', 'google/gemini-3-flash', 'fast', true, false),
  ('default', 'google/gemini-2.5-flash', 'fast', true, false),
  ('default', 'xai/grok-4.20-non-reasoning', 'fast', true, false),
  ('default', 'xai/grok-4.1-fast-non-reasoning', 'fast', true, false),
  ('default', 'xai/grok-4-fast-non-reasoning', 'fast', true, false),
  ('default', 'xai/grok-code-fast-1', 'fast', true, false),
  ('default', 'deepseek/deepseek-v3.2', 'fast', true, false),
  ('default', 'openai/text-embedding-3-small', 'embedding', true, true),
  ('default', 'openai/text-embedding-3-large', 'embedding', true, false),
  ('default', 'google/text-embedding-005', 'embedding', true, false),
  ('default', 'anthropic/claude-opus-4-6', 'escalation', true, true)
ON CONFLICT ("workspace_id", "model_id", "category") DO UPDATE
SET
  "enabled" = EXCLUDED."enabled",
  "is_default" = EXCLUDED."is_default",
  "updated_at" = now();
