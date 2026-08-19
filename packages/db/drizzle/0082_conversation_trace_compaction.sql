ALTER TABLE "conversation_traces" ADD COLUMN "compacted_tool_results" integer;--> statement-breakpoint
ALTER TABLE "conversation_traces" ADD COLUMN "compaction_tokens_saved" integer;
