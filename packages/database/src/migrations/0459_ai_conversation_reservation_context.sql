-- Explain from a reservation (v0.1.45, plan 2026-10-11 section 4.3): the
-- context kind 'reservation' (context_id is reservations.id). Idempotent.
ALTER TABLE "ai_conversations" DROP CONSTRAINT IF EXISTS "ai_conversations_context_check";
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_context_check"
  CHECK (("context_kind" IS NULL AND "context_id" IS NULL)
    OR ("context_kind" IN ('station', 'session', 'authorization', 'reservation') AND "context_id" IS NOT NULL));
