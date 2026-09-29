-- Dashboard snapshot money moves to one row per currency (GitHub issue #11).
-- Existing snapshot amounts never recorded a currency, so the backfill labels
-- them with the company currency, the only currency single-currency networks
-- have. The five money columns are then dropped from dashboard_snapshots.
CREATE TABLE IF NOT EXISTS "dashboard_snapshot_revenue" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"currency" varchar(3) NOT NULL,
	"total_revenue_cents" bigint DEFAULT 0 NOT NULL,
	"day_revenue_cents" bigint DEFAULT 0 NOT NULL,
	"total_sessions" integer DEFAULT 0 NOT NULL,
	"total_electricity_cost_cents" bigint DEFAULT 0 NOT NULL,
	"day_electricity_cost_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dashboard_snapshot_revenue" ADD CONSTRAINT "uq_dashboard_snapshot_revenue_site_date_currency" UNIQUE("site_id","snapshot_date","currency");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dashboard_snapshot_revenue_date" ON "dashboard_snapshot_revenue" ("snapshot_date");
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'dashboard_snapshots' AND column_name = 'total_revenue_cents'
	) THEN
		INSERT INTO "dashboard_snapshot_revenue" (
			"site_id", "snapshot_date", "currency", "total_revenue_cents", "day_revenue_cents",
			"total_sessions", "total_electricity_cost_cents", "day_electricity_cost_cents"
		)
		SELECT
			ds.site_id,
			ds.snapshot_date,
			COALESCE(
				(SELECT upper(s.value #>> '{}') FROM settings s
				 WHERE s.key = 'company.currency' AND (s.value #>> '{}') ~ '^[A-Za-z]{3}$'),
				'USD'
			),
			COALESCE(ds.total_revenue_cents, 0),
			COALESCE(ds.day_revenue_cents, 0),
			COALESCE(ds.total_sessions, 0),
			COALESCE(ds.total_electricity_cost_cents, 0),
			COALESCE(ds.day_electricity_cost_cents, 0)
		FROM dashboard_snapshots ds
		WHERE COALESCE(ds.total_revenue_cents, 0) <> 0
			OR COALESCE(ds.day_revenue_cents, 0) <> 0
			OR COALESCE(ds.total_electricity_cost_cents, 0) <> 0
			OR COALESCE(ds.day_electricity_cost_cents, 0) <> 0
		ON CONFLICT ("site_id", "snapshot_date", "currency") DO NOTHING;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" DROP COLUMN IF EXISTS "total_revenue_cents";
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" DROP COLUMN IF EXISTS "day_revenue_cents";
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" DROP COLUMN IF EXISTS "avg_revenue_cents_per_session";
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" DROP COLUMN IF EXISTS "total_electricity_cost_cents";
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" DROP COLUMN IF EXISTS "day_electricity_cost_cents";
