-- Payments P8 (contract, v0.1.39), step 1 of 3: copy into the provider columns every
-- stripe_* id that pods of v0.1.37 wrote after the 0121/0122 backfill, then
-- check that no row keeps an id only in a stripe_* column. Row locks only.
-- The stripe_* blocks run only while the 0120 functions exist (0149 drops
-- them) and their stripe_* column exists, so the file is re-runnable.
DO $$
DECLARE
	expand_functions boolean := to_regprocedure('evtivity_payment_provider_of(text[])') IS NOT NULL
		AND to_regprocedure('evtivity_normalize_top_ups(jsonb, integer, integer)') IS NOT NULL;
BEGIN
	IF expand_functions AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'payment_records' AND column_name = 'stripe_payment_intent_id'
	) THEN
		UPDATE "payment_records"
		SET "provider_payment_id" = COALESCE("provider_payment_id", NULLIF("stripe_payment_intent_id", '')),
			"provider_customer_id" = COALESCE("provider_customer_id", NULLIF("stripe_customer_id", '')),
			"provider_payment_method_id" = COALESCE("provider_payment_method_id", NULLIF("stripe_payment_method_id", '')),
			"provider" = COALESCE("provider", evtivity_payment_provider_of(
				"provider_payment_id", "provider_customer_id", "provider_payment_method_id",
				"stripe_payment_intent_id", "stripe_customer_id", "stripe_payment_method_id"))
		WHERE ("provider_payment_id" IS NULL AND NULLIF("stripe_payment_intent_id", '') IS NOT NULL)
			OR ("provider_customer_id" IS NULL AND NULLIF("stripe_customer_id", '') IS NOT NULL)
			OR ("provider_payment_method_id" IS NULL AND NULLIF("stripe_payment_method_id", '') IS NOT NULL)
			OR ("provider" IS NULL AND COALESCE("provider_payment_id", "provider_customer_id", "provider_payment_method_id") IS NOT NULL);

		UPDATE "payment_records"
		SET "metadata" = evtivity_normalize_top_ups("metadata", "captured_amount_cents", "pre_auth_amount_cents")
		WHERE jsonb_typeof("metadata") = 'object' AND "metadata" ? 'topUpIntentId' AND NOT ("metadata" ? 'topUps');

		IF EXISTS (
			SELECT 1 FROM "payment_records"
			WHERE ("provider_payment_id" IS NULL AND NULLIF("stripe_payment_intent_id", '') IS NOT NULL)
				OR ("provider_customer_id" IS NULL AND NULLIF("stripe_customer_id", '') IS NOT NULL)
				OR ("provider_payment_method_id" IS NULL AND NULLIF("stripe_payment_method_id", '') IS NOT NULL)
				OR ("provider_payment_id" IS NOT NULL AND "provider" IS NULL)
		) THEN
			RAISE EXCEPTION 'payment_records: rows with a stripe_* id but no provider id remain after the backfill';
		END IF;
	END IF;

	IF expand_functions AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'driver_payment_methods' AND column_name = 'stripe_payment_method_id'
	) THEN
		UPDATE "driver_payment_methods"
		SET "provider_customer_id" = COALESCE("provider_customer_id", NULLIF("stripe_customer_id", '')),
			"provider_payment_method_id" = COALESCE("provider_payment_method_id", NULLIF("stripe_payment_method_id", '')),
			"provider" = COALESCE("provider", evtivity_payment_provider_of(
				"provider_customer_id", "provider_payment_method_id", "stripe_customer_id", "stripe_payment_method_id"))
		WHERE "provider" IS NULL OR "provider_customer_id" IS NULL OR "provider_payment_method_id" IS NULL;
	END IF;

	-- 0149 makes these columns NOT NULL. A saved method without its ids
	-- cannot be charged or removed at the provider; stop with a clear message
	-- instead of a NOT NULL violation.
	IF EXISTS (
		SELECT 1 FROM "driver_payment_methods"
		WHERE "provider" IS NULL OR "provider_customer_id" IS NULL OR "provider_payment_method_id" IS NULL
	) THEN
		RAISE EXCEPTION 'driver_payment_methods: rows without provider, provider_customer_id or provider_payment_method_id remain; fix or delete them before upgrading';
	END IF;

	IF expand_functions AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'guest_sessions' AND column_name = 'stripe_payment_intent_id'
	) THEN
		UPDATE "guest_sessions"
		SET "provider_payment_id" = COALESCE("provider_payment_id", NULLIF("stripe_payment_intent_id", '')),
			"provider" = COALESCE("provider", evtivity_payment_provider_of("provider_payment_id", "stripe_payment_intent_id"))
		WHERE ("provider_payment_id" IS NULL AND NULLIF("stripe_payment_intent_id", '') IS NOT NULL)
			OR ("provider" IS NULL AND "provider_payment_id" IS NOT NULL);

		IF EXISTS (
			SELECT 1 FROM "guest_sessions"
			WHERE "provider_payment_id" IS NULL AND NULLIF("stripe_payment_intent_id", '') IS NOT NULL
		) THEN
			RAISE EXCEPTION 'guest_sessions: rows with a stripe_payment_intent_id but no provider_payment_id remain after the backfill';
		END IF;
	END IF;

	IF expand_functions AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'site_payment_configs' AND column_name = 'stripe_connected_account_id'
	) THEN
		UPDATE "site_payment_configs"
		SET "payout_account_id" = NULLIF("stripe_connected_account_id", '')
		WHERE "payout_account_id" IS NULL AND NULLIF("stripe_connected_account_id", '') IS NOT NULL;
	END IF;

	IF expand_functions AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'drivers' AND column_name = 'stripe_customer_id'
	) THEN
		INSERT INTO "driver_payment_customers" ("driver_id", "provider", "provider_customer_id")
		SELECT "id", evtivity_payment_provider_of("stripe_customer_id"), "stripe_customer_id"
		FROM "drivers"
		WHERE NULLIF("stripe_customer_id", '') IS NOT NULL
		ON CONFLICT ("driver_id", "provider") DO NOTHING;
	END IF;

	INSERT INTO "driver_payment_customers" ("driver_id", "provider", "provider_customer_id")
	SELECT DISTINCT ON ("driver_id", "provider") "driver_id", "provider", "provider_customer_id"
	FROM "driver_payment_methods"
	ORDER BY "driver_id", "provider", "created_at", "id"
	ON CONFLICT ("driver_id", "provider") DO NOTHING;
END $$;
