-- One vote per user and insight (v0.1.45). Votes were audit rows only, one per
-- click; the latest vote of each user on each insight seeds the table. The
-- reason is untrusted operator text, never sent to a model. Idempotent.
ALTER TYPE "ai_insight_audit_action" ADD VALUE IF NOT EXISTS 'feedback_cleared';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_insight_feedback" (
  "insight_id" text NOT NULL,
  "user_id" text NOT NULL,
  "helpful" boolean NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "uq_ai_insight_feedback_insight_user" UNIQUE ("insight_id", "user_id")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insight_feedback" ADD CONSTRAINT "ai_insight_feedback_insight_id_ai_insights_id_fk"
    FOREIGN KEY ("insight_id") REFERENCES "public"."ai_insights"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insight_feedback" ADD CONSTRAINT "ai_insight_feedback_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insight_feedback_user" ON "ai_insight_feedback" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insight_feedback_updated" ON "ai_insight_feedback" ("updated_at");--> statement-breakpoint
INSERT INTO "ai_insight_feedback" ("insight_id", "user_id", "helpful", "created_at", "updated_at")
SELECT DISTINCT ON (a."ai_insight_id", a."actor_user_id")
  a."ai_insight_id", a."actor_user_id", a."action" = 'feedback_helpful', a."created_at", a."created_at"
FROM "ai_insight_audit_log" a
JOIN "ai_insights" i ON i."id" = a."ai_insight_id"
JOIN "users" u ON u."id" = a."actor_user_id"
WHERE a."action" IN ('feedback_helpful', 'feedback_wrong')
ORDER BY a."ai_insight_id", a."actor_user_id", a."created_at" DESC, a."id" DESC
ON CONFLICT ("insight_id", "user_id") DO NOTHING;
