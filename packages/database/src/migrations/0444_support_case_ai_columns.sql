-- Driver AI support (plan v0.1.45, section 2.4): the consent the driver gave
-- per case (server time, language, notice version), the state of the AI
-- step, the action codes of the answer, and who resolved the case. Null
-- consent: the driver was not asked. Idempotent.
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent" varchar(10);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent_language" varchar(10);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent_notice_version" integer;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_state" varchar(20);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_state_reason" varchar(40);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_answered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_feedback_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_driver_actions" jsonb;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "resolution_source" varchar(10);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_ai_consent_check"
    CHECK ("ai_consent" IN ('granted', 'declined'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_ai_consent_fields_check"
    CHECK (
      ("ai_consent_at" IS NULL AND "ai_consent_language" IS NULL AND "ai_consent_notice_version" IS NULL)
      OR ("ai_consent_at" IS NOT NULL AND "ai_consent_language" IS NOT NULL AND "ai_consent_notice_version" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_ai_state_check"
    CHECK ("ai_state" IN ('queued', 'analyzing', 'awaiting_feedback', 'resolved_by_ai', 'escalated', 'failed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_resolution_source_check"
    CHECK ("resolution_source" IN ('operator', 'ai'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_cases_ai_state_open"
  ON "support_cases" ("ai_state", "created_at")
  WHERE "ai_state" IN ('queued', 'analyzing', 'awaiting_feedback');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_cases_driver_ai_consent"
  ON "support_cases" ("driver_id", "ai_consent_at")
  WHERE "ai_consent" = 'granted';
