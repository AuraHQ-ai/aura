ALTER TABLE "notes" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "inject_in_context" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "importance" smallint NOT NULL DEFAULT 50;--> statement-breakpoint
UPDATE "notes" SET "inject_in_context" = true WHERE "category" = 'skill';
