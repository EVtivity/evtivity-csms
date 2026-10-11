-- Automatic insights (roadmap v0.1.44, item 1): one row per root-cause note
-- about a station, a session, a refused authorization or a site. The unique
-- trigger key makes the minute scan idempotent across replicas. Texts hold
-- the canonical summary and its lazy translations, one row per language.
-- Idempotent.
CREATE TABLE IF NOT EXISTS "ai_insights" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" varchar(32) NOT NULL,
  "subject_type" varchar(20) NOT NULL,
  "subject_id" text NOT NULL,
  "station_id" text REFERENCES "charging_stations"("id") ON DELETE CASCADE,
  "session_id" text REFERENCES "charging_sessions"("id") ON DELETE CASCADE,
  "authorize_attempt_id" integer REFERENCES "authorize_attempts"("id") ON DELETE SET NULL,
  "site_id" text REFERENCES "sites"("id") ON DELETE SET NULL,
  "parent_insight_id" text REFERENCES "ai_insights"("id") ON DELETE SET NULL,
  "trigger_key" varchar(200) NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "skip_reason" varchar(40),
  "category" varchar(32),
  "confidence" varchar(10),
  "fixes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "basis_at" timestamp with time zone,
  "basis_fingerprint" varchar(64),
  "primary_language" varchar(10) NOT NULL,
  "generated_by" varchar(10),
  "provider" varchar(20),
  "model" varchar(200),
  "requested_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  "dismissed_by" text REFERENCES "users"("id") ON DELETE SET NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insights" ADD CONSTRAINT "uq_ai_insights_trigger"
    UNIQUE ("kind", "subject_type", "subject_id", "trigger_key");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_status_check"
    CHECK (status IN ('pending', 'active', 'resolved', 'superseded', 'skipped', 'failed', 'dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_subject_type_check"
    CHECK (subject_type IN ('station', 'session', 'authorization', 'site', 'company'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_generated_by_check"
    CHECK (generated_by IS NULL OR generated_by IN ('model', 'rule'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_site_status_created" ON "ai_insights" ("site_id", "status", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_station_created" ON "ai_insights" ("station_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_session" ON "ai_insights" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_parent" ON "ai_insights" ("parent_insight_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_status_created" ON "ai_insights" ("status", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_authorize_attempt" ON "ai_insights" ("authorize_attempt_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_insight_texts" (
  "insight_id" text NOT NULL REFERENCES "ai_insights"("id") ON DELETE CASCADE,
  "language" varchar(10) NOT NULL,
  "summary" text,
  "status" varchar(16) NOT NULL,
  "source" varchar(16) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_insight_texts_pk" PRIMARY KEY ("insight_id", "language")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insight_texts" ADD CONSTRAINT "ai_insight_texts_status_check"
    CHECK (status IN ('ready', 'pending', 'unavailable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insight_texts" ADD CONSTRAINT "ai_insight_texts_source_check"
    CHECK (source IN ('generated', 'translated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
