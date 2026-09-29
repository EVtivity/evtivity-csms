-- The platform runs in one currency: the company.currency setting.
-- This is the expand step. Pods from the previous release can still be
-- running during a rolling upgrade, so nothing they read or write is removed
-- here. The next release drops tariffs.currency, site_payment_configs.currency,
-- ocpi_tariff_mappings.currency, the stripe.currency and pricing.currency
-- settings, and dashboard_snapshot_revenue, and makes
-- charging_sessions.currency NOT NULL.
--
-- 1. Align company.currency with the currency drivers were actually charged
--    in: the latest payment, else the latest billed session, else the
--    stripe.currency setting. Before this release company.currency was
--    display-only and often left at its USD default.
DO $$
DECLARE
	charged text;
	current_company text;
BEGIN
	SELECT upper(currency) INTO charged
	FROM payment_records
	WHERE status IN ('captured', 'partially_refunded', 'pre_authorized')
		AND currency ~ '^[A-Za-z]{3}$'
	ORDER BY created_at DESC
	LIMIT 1;

	IF charged IS NULL THEN
		SELECT upper(currency) INTO charged
		FROM charging_sessions
		WHERE COALESCE(final_cost_cents, current_cost_cents, 0) > 0
			AND currency ~ '^[A-Za-z]{3}$'
		ORDER BY started_at DESC NULLS LAST
		LIMIT 1;
	END IF;

	IF charged IS NULL THEN
		SELECT upper(value #>> '{}') INTO charged
		FROM settings
		WHERE key = 'stripe.currency' AND (value #>> '{}') ~ '^[A-Za-z]{3}$';
	END IF;

	SELECT upper(value #>> '{}') INTO current_company
	FROM settings WHERE key = 'company.currency';

	IF charged IS NOT NULL AND charged IS DISTINCT FROM current_company THEN
		INSERT INTO settings (key, value)
		VALUES ('company.currency', to_jsonb(charged))
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
		RAISE NOTICE 'company.currency set to % (was %): the currency drivers were charged in', charged, current_company;
		current_company := charged;
	END IF;

	IF current_company IS NOT NULL
		AND current_company NOT IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL',
			'MXN', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'ZAR', 'ILS', 'AED', 'SAR', 'TWD', 'THB',
			'PLN', 'CZK', 'HUF', 'TRY', 'COP', 'ARS', 'PHP', 'MYR', 'IDR') THEN
		RAISE WARNING 'company.currency % is not a supported two-decimal currency: the platform bills in USD until it is changed in Settings > Company', current_company;
	END IF;

	-- Rows that pods from the previous release still insert during the
	-- rollout take the company currency, not the old USD column default.
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'tariffs' AND column_name = 'currency'
	) THEN
		EXECUTE format('ALTER TABLE tariffs ALTER COLUMN currency SET DEFAULT %L',
			CASE WHEN current_company IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL',
			'MXN', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'ZAR', 'ILS', 'AED', 'SAR', 'TWD', 'THB',
			'PLN', 'CZK', 'HUF', 'TRY', 'COP', 'ARS', 'PHP', 'MYR', 'IDR') THEN current_company ELSE 'USD' END);
	END IF;
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'site_payment_configs'
			AND column_name = 'currency'
	) THEN
		EXECUTE format('ALTER TABLE site_payment_configs ALTER COLUMN currency SET DEFAULT %L',
			CASE WHEN current_company IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL',
			'MXN', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'ZAR', 'ILS', 'AED', 'SAR', 'TWD', 'THB',
			'PLN', 'CZK', 'HUF', 'TRY', 'COP', 'ARS', 'PHP', 'MYR', 'IDR') THEN current_company ELSE 'USD' END);
	END IF;
END $$;
--> statement-breakpoint
-- 2. Every session records the currency it was billed in: the company
--    currency, resolved the way the application does (unsupported -> USD).
UPDATE charging_sessions
SET currency = COALESCE(
	(SELECT upper(s.value #>> '{}') FROM settings s
	 WHERE s.key = 'company.currency'
		AND upper(s.value #>> '{}') IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL',
		'MXN', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'ZAR', 'ILS', 'AED', 'SAR', 'TWD', 'THB',
		'PLN', 'CZK', 'HUF', 'TRY', 'COP', 'ARS', 'PHP', 'MYR', 'IDR')),
	'USD'
)
WHERE currency IS NULL;
--> statement-breakpoint
-- 3. New code publishes OCPI tariff mappings without a currency.
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'ocpi_tariff_mappings'
			AND column_name = 'currency'
	) THEN
		ALTER TABLE "ocpi_tariff_mappings" ALTER COLUMN "currency" DROP NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
-- 4. Snapshot money returns to dashboard_snapshots as bigint (cumulative
--    cents outgrow integer), in the company currency. 0087's per-currency
--    table stays until the next release.
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "total_revenue_cents" bigint;
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "day_revenue_cents" bigint;
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "avg_revenue_cents_per_session" bigint;
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "total_electricity_cost_cents" bigint;
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "day_electricity_cost_cents" bigint;
--> statement-breakpoint
DO $$ BEGIN
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
			WHERE upper(dsr.currency) = COALESCE(
				(SELECT upper(s.value #>> '{}') FROM settings s WHERE s.key = 'company.currency'),
				'USD'
			)
			GROUP BY dsr.site_id, dsr.snapshot_date
		) r
		WHERE ds.site_id = r.site_id AND ds.snapshot_date = r.snapshot_date
			AND ds.total_revenue_cents IS NULL;
	END IF;
END $$;
