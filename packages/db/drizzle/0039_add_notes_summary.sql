ALTER TABLE "notes" ADD COLUMN "summary" text;
ALTER TABLE "notes" ADD COLUMN "inject_in_context" boolean NOT NULL DEFAULT false;
ALTER TABLE "notes" ADD COLUMN "importance" smallint NOT NULL DEFAULT 50;
UPDATE "notes" SET "inject_in_context" = true WHERE "category" = 'skill';
