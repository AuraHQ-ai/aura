CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"header_name" text,
	"encrypted_header_value" text,
	"visibility" text DEFAULT 'personal' NOT NULL,
	"owner_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"trusted" boolean DEFAULT false NOT NULL,
	"cached_tools" jsonb,
	"tools_cached_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" IN ('http','sse')),
	CONSTRAINT "mcp_servers_auth_type_check" CHECK ("mcp_servers"."auth_type" IN ('none','header','oauth')),
	CONSTRAINT "mcp_servers_visibility_check" CHECK ("mcp_servers"."visibility" IN ('workspace','personal'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending_auth' NOT NULL,
	"encrypted_tokens" text,
	"encrypted_client_info" text,
	"encrypted_code_verifier" text,
	"encrypted_as_info" text,
	"oauth_state" text,
	"expires_at" timestamp with time zone,
	"channel_id" text,
	"thread_ts" text,
	"dynamically_registered" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connections_status_check" CHECK ("mcp_connections"."status" IN ('pending_auth','connected','error','expired'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_workspace_slug_idx" ON "mcp_servers" ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_workspace_visibility_idx" ON "mcp_servers" ("workspace_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_connections_workspace_server_user_idx" ON "mcp_connections" ("workspace_id","server_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_connections_workspace_oauth_state_idx" ON "mcp_connections" ("workspace_id","oauth_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_connections_user_idx" ON "mcp_connections" ("user_id");
