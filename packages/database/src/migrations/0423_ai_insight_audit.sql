-- Automatic insight audit entity (ai_insight): an operator regenerated or
-- dismissed an insight, or marked it helpful or wrong. Idempotent.
DO $$ BEGIN
  CREATE TYPE "ai_insight_audit_action" AS ENUM ('regenerated', 'dismissed', 'feedback_helpful', 'feedback_wrong');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_insight_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "ai_insight_id" text,
  "ai_insight_id_snapshot" text NOT NULL,
  "action" "ai_insight_audit_action" NOT NULL,
  "actor" "audit_actor" NOT NULL,
  "actor_user_id" text,
  "actor_driver_id" text,
  "actor_api_key_id" text,
  "actor_label" varchar(100),
  "before" jsonb,
  "after" jsonb,
  "notes" text,
  "via_ai" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insight_audit_insight_id" ON "ai_insight_audit_log" ("ai_insight_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insight_audit_created_at" ON "ai_insight_audit_log" ("created_at");
