CREATE TABLE IF NOT EXISTS "skill_embeddings" (
  "workspace_id" text DEFAULT 'default' NOT NULL,
  "id" uuid PRIMARY KEY NOT NULL,
  "embedding" vector(1536) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "skill_embeddings_id_notes_id_fk" FOREIGN KEY ("id") REFERENCES "notes"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_embeddings_embedding_idx" ON "skill_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_retrievals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text DEFAULT 'default' NOT NULL,
  "turn_id" text NOT NULL,
  "user_id" text NOT NULL,
  "skill_id" uuid NOT NULL,
  "similarity" real NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_retrievals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "skill_retrievals_skill_id_notes_id_fk" FOREIGN KEY ("skill_id") REFERENCES "notes"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_retrievals_turn_idx" ON "skill_retrievals" USING btree ("workspace_id","turn_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_retrievals_user_ts_idx" ON "skill_retrievals" USING btree ("workspace_id","user_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_retrievals_skill_ts_idx" ON "skill_retrievals" USING btree ("workspace_id","skill_id","ts");--> statement-breakpoint
