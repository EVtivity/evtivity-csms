-- Automatic insights: the per-subject cooldown claim (one model insight per
-- subject and kind per window, claimed atomically; the insight holding the
-- claim may claim again, so its job retries) and the scan watermark per
-- source table. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_insight_cooldowns" (
  "subject_type" varchar(20) NOT NULL,
  "subject_id" text NOT NULL,
  "kind" varchar(32) NOT NULL,
  "next_allowed_at" timestamp with time zone NOT NULL,
  "claimed_by_insight_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_insight_cooldowns_pk" PRIMARY KEY ("subject_type", "subject_id", "kind")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insight_cooldowns_next_allowed" ON "ai_insight_cooldowns" ("next_allowed_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_insight_scan_state" (
  "source" varchar(40) PRIMARY KEY NOT NULL,
  "last_id" bigint,
  "last_at" timestamp with time zone,
  "last_key" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
