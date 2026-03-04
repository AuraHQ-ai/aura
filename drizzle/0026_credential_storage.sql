-- Migration: 0026_credential_storage
-- Encrypted credential storage with per-user access control

CREATE TABLE IF NOT EXISTS "credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" text NOT NULL,
  "name" text NOT NULL CONSTRAINT credentials_name_format CHECK (name ~ '^[a-z][a-z0-9_]{1,62}$'),
  "value" text NOT NULL,
  "key_version" integer DEFAULT 1 NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credentials_owner_name_unique" UNIQUE ("owner_id", "name")
);

CREATE TABLE IF NOT EXISTS "credential_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "credential_id" uuid NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
  "grantee_id" text NOT NULL,
  "permission" text NOT NULL CONSTRAINT credential_grants_permission_check CHECK (permission IN ('read', 'write', 'admin')),
  "granted_by" text,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "credential_grants_credential_grantee_unique" UNIQUE ("credential_id", "grantee_id")
);

CREATE TABLE IF NOT EXISTS "credential_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "credential_id" uuid REFERENCES "credentials"("id") ON DELETE SET NULL,
  "credential_name" text,
  "accessed_by" text,
  "action" text NOT NULL CONSTRAINT credential_audit_log_action_check CHECK (action IN ('read', 'create', 'update', 'delete', 'grant', 'revoke', 'use')),
  "context" text,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS "credential_grants_grantee_idx" ON "credential_grants" ("grantee_id");
CREATE INDEX IF NOT EXISTS "credential_audit_log_credential_ts_idx" ON "credential_audit_log" ("credential_id", "timestamp");
CREATE INDEX IF NOT EXISTS "credential_audit_log_accessed_by_ts_idx" ON "credential_audit_log" ("accessed_by", "timestamp");
