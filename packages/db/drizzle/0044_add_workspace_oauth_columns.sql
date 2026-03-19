ALTER TABLE "workspaces" ADD COLUMN "bot_token" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "bot_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "installer_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "scopes" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "is_active" boolean NOT NULL DEFAULT true;
