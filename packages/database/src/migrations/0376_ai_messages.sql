-- AI conversation messages: user messages, assistant responses (text, tool
-- calls, the provider's opaque state) and tool results (redacted). usage
-- holds the token counts of the model calls, cost_micros their provider cost
-- in micro-USD. The created_at index serves the daily token budget. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
  "role" varchar(20) NOT NULL,
  "parts" jsonb NOT NULL,
  "provider_state" jsonb,
  "usage" jsonb,
  "cost_micros" bigint,
  "finish_reason" varchar(30),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_role_check"
    CHECK (role IN ('user', 'assistant', 'tool'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_messages_conversation" ON "ai_messages" ("conversation_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_messages_created_at" ON "ai_messages" ("created_at");
