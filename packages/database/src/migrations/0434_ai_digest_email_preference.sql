-- Opt-in daily AI proposal digest email per operator (default off). System
-- events are always on, so the digest needs its own opt-in. Idempotent.
ALTER TABLE "user_notification_preferences" ADD COLUMN IF NOT EXISTS "ai_digest_email" boolean DEFAULT false NOT NULL;
