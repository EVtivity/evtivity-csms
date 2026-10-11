-- AI assistant Explain: the record a conversation is about. context_kind is
-- 'station', 'session' or 'authorization', context_id the record's id (no FK,
-- the targets have mixed key types). Both null for an ordinary conversation.
-- Idempotent.

ALTER TABLE "ai_conversations" ADD COLUMN IF NOT EXISTS "context_kind" varchar(20);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN IF NOT EXISTS "context_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_context_check"
    CHECK (("context_kind" IS NULL AND "context_id" IS NULL)
      OR ("context_kind" IN ('station', 'session', 'authorization') AND "context_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
