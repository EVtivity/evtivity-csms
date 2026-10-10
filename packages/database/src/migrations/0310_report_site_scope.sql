-- Site scope of reports and report schedules (v0.1.43). site_scope holds the
-- sites a report covers and who may see it: NULL means all sites (all-site
-- users only), an array means only stations at those sites. No backfill:
-- existing rows stay NULL, so site-restricted users no longer see them, and an
-- existing schedule runs with its creator's current site access.
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "site_scope" text[];
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "site_scope" text[];
