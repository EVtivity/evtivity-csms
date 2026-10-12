-- The AI Inbox merges into AI Insights (v0.1.45): a background worker
-- suggestion is now an insight that carries an action (an `ai_proposals` row,
-- one per insight). No data migration (owner decision 2026-10-12): stored
-- proposals that no worker action insight carries are deleted. The
-- `aiProposals:*` permissions are removed from users, roles and API keys;
-- insight actions use `aiInsights:*`. The table is locked first so a v0.1.44
-- pod cannot add a proposal without an insight between the delete and the NOT
-- NULL. source (now defaulting to 'worker'), requested_by_user_id, api_key_id,
-- rationale_text and rationale_language stay until v0.1.46 (v0.1.44 pods read
-- and insert them). Idempotent: a rerun keeps the live actions.
LOCK TABLE "ai_proposals" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "ai_proposals" p
WHERE p."insight_id" IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM "ai_insights" i
    WHERE i."id" = p."insight_id" AND i."kind" IN ('stuck_session', 'station_long_faulted')
  );--> statement-breakpoint
ALTER TABLE "ai_proposals" ALTER COLUMN "source" SET DEFAULT 'worker';--> statement-breakpoint
ALTER TABLE "ai_proposals" ALTER COLUMN "insight_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_insight_id_ai_insights_id_fk"
    FOREIGN KEY ("insight_id") REFERENCES "public"."ai_insights"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_proposals_insight" ON "ai_proposals" ("insight_id");--> statement-breakpoint
DELETE FROM "user_permissions" WHERE "permission" IN ('aiProposals:read', 'aiProposals:write');--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" - 'aiProposals:read' - 'aiProposals:write'
WHERE jsonb_typeof("permissions") = 'array'
  AND "permissions" ?| ARRAY['aiProposals:read', 'aiProposals:write'];--> statement-breakpoint
UPDATE "refresh_tokens"
SET "permissions" = "permissions" - 'aiProposals:read' - 'aiProposals:write'
WHERE jsonb_typeof("permissions") = 'array'
  AND "permissions" ?| ARRAY['aiProposals:read', 'aiProposals:write'];
