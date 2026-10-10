-- AI pending actions: a write tool call that waits for the user's
-- confirmation. The nonce is stored as a SHA-256 hash, the arguments are
-- bound by args_hash, and a decision moves the status from 'pending' only
-- (compare-and-set), so a confirm runs the write at most once. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_pending_actions" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
  "tool_call_row_id" text NOT NULL REFERENCES "ai_tool_calls"("id") ON DELETE CASCADE,
  "tool_message_id" text NOT NULL REFERENCES "ai_messages"("id") ON DELETE CASCADE,
  "tool_call_id" varchar(200) NOT NULL,
  "operation_id" varchar(200) NOT NULL,
  "args" jsonb NOT NULL,
  "args_hash" varchar(64) NOT NULL,
  "nonce_hash" varchar(64) NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_pending_actions" ADD CONSTRAINT "ai_pending_actions_status_check"
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired', 'superseded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_pending_actions_conversation" ON "ai_pending_actions" ("conversation_id", "status");
