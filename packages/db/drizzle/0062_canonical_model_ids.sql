ALTER TABLE "conversation_traces" ADD COLUMN IF NOT EXISTS "resolved_model_id" text;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "resolved_model_id" text;--> statement-breakpoint

WITH first_assistant_message AS (
  SELECT DISTINCT ON (cm.conversation_id)
    cm.conversation_id,
    cm.model_id AS raw_model_id
  FROM "conversation_messages" cm
  WHERE cm.role = 'assistant'
    AND cm.model_id IS NOT NULL
  ORDER BY cm.conversation_id, cm.order_index ASC
)
UPDATE "conversation_traces" ct
SET "resolved_model_id" = fam.raw_model_id
FROM first_assistant_message fam
WHERE ct.id = fam.conversation_id
  AND ct.resolved_model_id IS NULL;--> statement-breakpoint

UPDATE "conversation_messages"
SET "resolved_model_id" = "model_id"
WHERE role = 'assistant'
  AND "model_id" IS NOT NULL
  AND "resolved_model_id" IS NULL;--> statement-breakpoint

UPDATE "conversation_messages" cm
SET "model_id" = ct."model_id"
FROM "conversation_traces" ct
WHERE cm.conversation_id = ct.id
  AND cm.role = 'assistant'
  AND ct."model_id" IS NOT NULL
  AND cm."model_id" IS DISTINCT FROM ct."model_id";--> statement-breakpoint
