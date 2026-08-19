-- Per-conversation cost tracking (issue #719)
-- Adds model_pricing table, cost_usd to conversation_traces,
-- and model_id + token_usage to conversation_messages.

CREATE TABLE IF NOT EXISTS "model_pricing" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model_id" text NOT NULL,
  "token_type" text NOT NULL,
  "price_per_million" numeric NOT NULL,
  "effective_from" date NOT NULL,
  "effective_until" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_pricing_model_token_date_unique" UNIQUE("model_id","token_type","effective_from"),
  CONSTRAINT "model_pricing_token_type_check" CHECK ("token_type" IN ('input', 'cache_read', 'cache_write', 'output', 'reasoning'))
); --> statement-breakpoint

CREATE INDEX IF NOT EXISTS "model_pricing_model_id_idx" ON "model_pricing" USING btree ("model_id"); --> statement-breakpoint

ALTER TABLE "conversation_traces" ADD COLUMN IF NOT EXISTS "cost_usd" numeric; --> statement-breakpoint

ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "model_id" text; --> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "token_usage" jsonb; --> statement-breakpoint

-- Seed current Anthropic pricing (March 2026)
-- Using gateway format: anthropic/model-name
INSERT INTO "model_pricing" ("model_id", "token_type", "price_per_million", "effective_from") VALUES
  -- Claude Opus 4.6
  ('claude-opus-4-6', 'input', 15, '2025-01-01'),
  ('claude-opus-4-6', 'cache_read', 1.50, '2025-01-01'),
  ('claude-opus-4-6', 'cache_write', 18.75, '2025-01-01'),
  ('claude-opus-4-6', 'output', 75, '2025-01-01'),
  ('claude-opus-4-6', 'reasoning', 75, '2025-01-01'),
  -- Claude Sonnet 4.6
  ('claude-sonnet-4-6', 'input', 3, '2025-01-01'),
  ('claude-sonnet-4-6', 'cache_read', 0.30, '2025-01-01'),
  ('claude-sonnet-4-6', 'cache_write', 3.75, '2025-01-01'),
  ('claude-sonnet-4-6', 'output', 15, '2025-01-01'),
  ('claude-sonnet-4-6', 'reasoning', 15, '2025-01-01'),
  -- Claude Haiku 3.5.6
  ('claude-haiku-3-5-6', 'input', 0.80, '2025-01-01'),
  ('claude-haiku-3-5-6', 'cache_read', 0.08, '2025-01-01'),
  ('claude-haiku-3-5-6', 'cache_write', 1.00, '2025-01-01'),
  ('claude-haiku-3-5-6', 'output', 4, '2025-01-01'),
  ('claude-haiku-3-5-6', 'reasoning', 4, '2025-01-01'),
  -- Also add with full date suffix variants (AI SDK may return these)
  ('claude-sonnet-4-20250514', 'input', 3, '2025-01-01'),
  ('claude-sonnet-4-20250514', 'cache_read', 0.30, '2025-01-01'),
  ('claude-sonnet-4-20250514', 'cache_write', 3.75, '2025-01-01'),
  ('claude-sonnet-4-20250514', 'output', 15, '2025-01-01'),
  ('claude-sonnet-4-20250514', 'reasoning', 15, '2025-01-01')
ON CONFLICT ("model_id", "token_type", "effective_from") DO NOTHING;
