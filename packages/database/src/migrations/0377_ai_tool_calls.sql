-- AI tool calls: every tool call a model made, with the operation it mapped
-- to, its redacted arguments, its outcome (ok, refused, error,
-- pending_confirmation, confirmed, rejected), the HTTP status, the latency and
-- what the redactor removed. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_tool_calls" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
  "message_id" text NOT NULL REFERENCES "ai_messages"("id") ON DELETE CASCADE,
  "tool_call_id" varchar(200) NOT NULL,
  "name" varchar(200) NOT NULL,
  "operation_id" varchar(200),
  "method" varchar(10),
  "path" text,
  "args" jsonb,
  "status" varchar(30) NOT NULL,
  "http_status" integer,
  "latency_ms" integer,
  "redaction_counts" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_tool_calls_conversation" ON "ai_tool_calls" ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_tool_calls_message" ON "ai_tool_calls" ("message_id");
