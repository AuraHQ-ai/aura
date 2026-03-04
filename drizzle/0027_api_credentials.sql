CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_owner_id_name_unique" UNIQUE("owner_id","name"),
	CONSTRAINT "credentials_name_check" CHECK (name ~ '^[a-z][a-z0-9_]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "credential_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"grantee_id" text NOT NULL,
	"permission" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "credential_grants_credential_id_grantee_id_unique" UNIQUE("credential_id","grantee_id"),
	CONSTRAINT "credential_grants_permission_check" CHECK (permission IN ('read', 'write', 'admin'))
);
--> statement-breakpoint
CREATE INDEX "idx_grants_grantee" ON "credential_grants" USING btree ("grantee_id");
--> statement-breakpoint
CREATE TABLE "credential_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid,
	"credential_name" text NOT NULL,
	"accessed_by" text NOT NULL,
	"action" text NOT NULL,
	"context" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_audit_log_action_check" CHECK (action IN ('read','create','update','delete','grant','revoke','use'))
);
--> statement-breakpoint
CREATE INDEX "idx_audit_credential" ON "credential_audit_log" USING btree ("credential_id","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_audit_accessed_by" ON "credential_audit_log" USING btree ("accessed_by","timestamp");
--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credential_audit_log" ADD CONSTRAINT "credential_audit_log_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;
