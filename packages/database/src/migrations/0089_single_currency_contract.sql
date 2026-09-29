-- The platform runs in one currency: the company.currency setting.
-- This is the contract step after 0088. It removes the currency fields nothing
-- reads any more and makes every session and dashboard snapshot carry a
-- currency. Every statement is guarded, so it also runs on installs that skip
-- from before 0087 or 0088.
--
-- 1. Snapshots record the currency of their money, so a later currency
--    change does not relabel it.
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
--> statement-breakpoint
-- 2. Resolve the company currency the way the application does
--    (unsupported -> USD). Move company-currency snapshot money that a worker
--    from the previous release wrote after 0088 ran, label existing snapshots
--    with the company currency, and stamp sessions that a previous release
--    wrote without a currency.
DO $$
DECLARE
	company text;
BEGIN
	SELECT upper(value #>> '{}') INTO company FROM settings WHERE key = 'company.currency';
	IF company IS NULL OR company NOT IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'CNY', 'INR',
		'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'ZAR', 'ILS', 'AED', 'SAR', 'TWD',
		'THB', 'PLN', 'CZK', 'HUF', 'TRY', 'COP', 'ARS', 'PHP', 'MYR', 'IDR') THEN
		company := 'USD';
	END IF;

	IF EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'dashboard_snapshot_revenue'
	) THEN
		UPDATE dashboard_snapshots ds
		SET total_revenue_cents = r.total_revenue_cents,
			day_revenue_cents = r.day_revenue_cents,
			avg_revenue_cents_per_session = CASE
				WHEN COALESCE(ds.total_sessions, 0) > 0 THEN round(r.total_revenue_cents::numeric / ds.total_sessions)
				ELSE 0
			END,
			total_electricity_cost_cents = r.total_electricity_cost_cents,
			day_electricity_cost_cents = r.day_electricity_cost_cents
		FROM (
			SELECT dsr.site_id, dsr.snapshot_date,
				sum(dsr.total_revenue_cents) AS total_revenue_cents,
				sum(dsr.day_revenue_cents) AS day_revenue_cents,
				sum(dsr.total_electricity_cost_cents) AS total_electricity_cost_cents,
				sum(dsr.day_electricity_cost_cents) AS day_electricity_cost_cents
			FROM dashboard_snapshot_revenue dsr
			WHERE upper(dsr.currency) = company
			GROUP BY dsr.site_id, dsr.snapshot_date
		) r
		WHERE ds.site_id = r.site_id AND ds.snapshot_date = r.snapshot_date
			AND ds.total_revenue_cents IS NULL;
	END IF;

	UPDATE dashboard_snapshots SET currency = company WHERE currency IS NULL;
	UPDATE charging_sessions SET currency = company WHERE currency IS NULL;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "dashboard_snapshot_revenue";
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ALTER COLUMN "currency" SET NOT NULL;
--> statement-breakpoint
-- 3. Every session has a currency. The application always sets it, so the
--    column has no default and an insert without one fails.
ALTER TABLE "charging_sessions" ALTER COLUMN "currency" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "charging_sessions" ALTER COLUMN "currency" SET NOT NULL;
--> statement-breakpoint
-- 4. Tariffs, site payment configs, and published OCPI tariffs have no
--    currency of their own.
ALTER TABLE "tariffs" DROP COLUMN IF EXISTS "currency";
--> statement-breakpoint
ALTER TABLE "site_payment_configs" DROP COLUMN IF EXISTS "currency";
--> statement-breakpoint
ALTER TABLE "ocpi_tariff_mappings" DROP COLUMN IF EXISTS "currency";
--> statement-breakpoint
-- 5. Stripe and pricing have no currency setting.
DELETE FROM settings WHERE key IN ('stripe.currency', 'pricing.currency');
