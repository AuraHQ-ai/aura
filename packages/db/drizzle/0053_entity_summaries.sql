DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='entities' AND column_name='summary') THEN
    ALTER TABLE "entities" ADD COLUMN "summary" text;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='entities' AND column_name='summary_updated_at') THEN
    ALTER TABLE "entities" ADD COLUMN "summary_updated_at" timestamptz;
  END IF;
END $$;
