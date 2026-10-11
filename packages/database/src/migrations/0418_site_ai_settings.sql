-- Per-site AI settings, changed only by users with access to every site:
-- ai_insights_enabled switches automatic insights off for one site, and
-- ai_monthly_token_budget overrides ai.budget.siteMonthlyTokens for the site
-- (null follows the setting, 0 means no limit). Idempotent.

ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "ai_insights_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "ai_monthly_token_budget" bigint;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sites" ADD CONSTRAINT "sites_ai_monthly_token_budget_check"
    CHECK ("ai_monthly_token_budget" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
