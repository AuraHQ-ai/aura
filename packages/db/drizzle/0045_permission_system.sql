-- Add role column to user_profiles
ALTER TABLE "user_profiles" ADD COLUMN "role" text NOT NULL DEFAULT 'member';--> statement-breakpoint

-- Add owner_id and visibility to notes for user scoping
ALTER TABLE "notes" ADD COLUMN "owner_id" text;--> statement-breakpoint

ALTER TABLE "notes" ADD COLUMN "visibility" text NOT NULL DEFAULT 'shared';--> statement-breakpoint

-- Create tool_definitions table
CREATE TABLE "tool_definitions" (
  "tool_name" text PRIMARY KEY,
  "min_role" text NOT NULL DEFAULT 'admin',
  "description" text,
  "category" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Create tool_credential_slots table
CREATE TABLE "tool_credential_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tool_name" text NOT NULL REFERENCES "tool_definitions"("tool_name"),
  "credential_type" text NOT NULL,
  "required" boolean NOT NULL DEFAULT true,
  "scope" text NOT NULL DEFAULT 'shared',
  "min_role" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Create rate_limits table
CREATE TABLE "rate_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role" text NOT NULL,
  "resource" text NOT NULL,
  "max_value" integer NOT NULL,
  UNIQUE("role", "resource")
);--> statement-breakpoint

-- Seed default rate limits
INSERT INTO "rate_limits" ("role", "resource", "max_value") VALUES
  ('member', 'active_jobs', 5),
  ('member', 'notes', 20),
  ('member', 'sandbox_calls_per_day', 0),
  ('member', 'cursor_agents_per_day', 0),
  ('member', 'subagent_calls_per_day', 0),
  ('power_user', 'active_jobs', 20),
  ('power_user', 'notes', 50),
  ('power_user', 'sandbox_calls_per_day', 50),
  ('power_user', 'cursor_agents_per_day', 3),
  ('power_user', 'subagent_calls_per_day', 10),
  ('admin', 'active_jobs', 100),
  ('admin', 'notes', 200),
  ('admin', 'sandbox_calls_per_day', 200),
  ('admin', 'cursor_agents_per_day', 10),
  ('admin', 'subagent_calls_per_day', 50);
