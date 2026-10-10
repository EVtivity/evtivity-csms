-- AI assistant conversations: one row per conversation of an operator with an
-- AI surface (chatbot or support assist). The server owns the history (the
-- client no longer sends it). turn_started_at is the lease of the running
-- turn. deleted_at hides a conversation the user deleted until the retention
-- cron removes it. Chat attachments (0380) point at their conversation, so
-- ai_attachments.conversation_id takes the conversation id type (text) and a
-- foreign key that clears it when the conversation is deleted. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "surface" varchar(20) NOT NULL,
  "support_case_id" text REFERENCES "support_cases"("id") ON DELETE CASCADE,
  "provider" varchar(20) NOT NULL,
  "model" varchar(200) NOT NULL,
  "title" varchar(200) DEFAULT '' NOT NULL,
  "turn_started_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_surface_check"
    CHECK (surface IN ('chatbot', 'support'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_conversations_user_updated" ON "ai_conversations" ("user_id", "updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_conversations_support_case" ON "ai_conversations" ("support_case_id");--> statement-breakpoint
ALTER TABLE "ai_attachments" ALTER COLUMN "conversation_id" TYPE text USING "conversation_id"::text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_attachments" ADD CONSTRAINT "ai_attachments_conversation_id_ai_conversations_id_fk"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
