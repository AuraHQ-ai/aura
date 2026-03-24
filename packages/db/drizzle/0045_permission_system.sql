-- Add role column to user_profiles
ALTER TABLE "user_profiles" ADD COLUMN "role" text NOT NULL DEFAULT 'member';--> statement-breakpoint

-- Add owner_id and visibility to notes for user scoping
ALTER TABLE "notes" ADD COLUMN "owner_id" text;--> statement-breakpoint

ALTER TABLE "notes" ADD COLUMN "visibility" text NOT NULL DEFAULT 'shared';--> statement-breakpoint

-- Create tool_definitions table
CREATE TABLE "tool_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL DEFAULT 'default' REFERENCES "workspaces"("id"),
  "tool_name" text NOT NULL,
  "min_role" text NOT NULL DEFAULT 'admin',
  "description" text,
  "category" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX "tool_definitions_workspace_tool_name_idx" ON "tool_definitions" ("workspace_id", "tool_name");--> statement-breakpoint

-- Create tool_credential_slots table
CREATE TABLE "tool_credential_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL DEFAULT 'default' REFERENCES "workspaces"("id"),
  "tool_definition_id" uuid NOT NULL REFERENCES "tool_definitions"("id"),
  "credential_type" text NOT NULL,
  "required" boolean NOT NULL DEFAULT true,
  "scope" text NOT NULL DEFAULT 'shared',
  "min_role" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Create rate_limits table
CREATE TABLE "rate_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL DEFAULT 'default' REFERENCES "workspaces"("id"),
  "role" text NOT NULL,
  "resource" text NOT NULL,
  "max_value" integer NOT NULL
);--> statement-breakpoint

ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_workspace_role_resource_unique" UNIQUE ("workspace_id", "role", "resource");--> statement-breakpoint

-- Seed default rate limits
INSERT INTO "rate_limits" ("workspace_id", "role", "resource", "max_value") VALUES
  ('default', 'member', 'active_jobs', 5),
  ('default', 'member', 'notes', 20),
  ('default', 'member', 'sandbox_calls_per_day', 0),
  ('default', 'member', 'cursor_agents_per_day', 0),
  ('default', 'member', 'subagent_calls_per_day', 0),
  ('default', 'power_user', 'active_jobs', 20),
  ('default', 'power_user', 'notes', 50),
  ('default', 'power_user', 'sandbox_calls_per_day', 50),
  ('default', 'power_user', 'cursor_agents_per_day', 3),
  ('default', 'power_user', 'subagent_calls_per_day', 10),
  ('default', 'admin', 'active_jobs', 100),
  ('default', 'admin', 'notes', 200),
  ('default', 'admin', 'sandbox_calls_per_day', 200),
  ('default', 'admin', 'cursor_agents_per_day', 10),
  ('default', 'admin', 'subagent_calls_per_day', 50);
