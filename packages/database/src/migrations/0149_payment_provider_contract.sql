-- Payments P8 (contract, v0.1.39), step 2 of 3: metadata changes. Pods of v0.1.38 and
-- later write the provider columns themselves, so the sync triggers of 0120
-- and their functions go. Saved methods always have a provider and its ids,
-- a payment id always has a provider, webhook events are keyed by provider
-- and event id, and the stripe.* copies of the payment settings are deleted
-- (v0.1.38 reads only payments.*). The NOT NULL changes scan
-- driver_payment_methods (small); the rest is metadata-only.
DROP TRIGGER IF EXISTS "payment_records_provider_sync" ON "payment_records";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "driver_payment_methods_provider_sync" ON "driver_payment_methods";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "guest_sessions_provider_sync" ON "guest_sessions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "site_payment_configs_payout_sync" ON "site_payment_configs";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "drivers_payment_customer_sync" ON "drivers";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "payment_records_provider_sync"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "driver_payment_methods_provider_sync"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "guest_sessions_provider_sync"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "site_payment_configs_payout_sync"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "drivers_payment_customer_sync"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "evtivity_payment_provider_of"(VARIADIC text[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "evtivity_normalize_top_ups"(jsonb, integer, integer);
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ALTER COLUMN "provider" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ALTER COLUMN "provider_customer_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ALTER COLUMN "provider_payment_method_id" SET NOT NULL;
--> statement-breakpoint
-- Validated in 0150 under a lock that lets reads and writes continue.
DO $$ BEGIN
	ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_provider_payment_id_check" CHECK ("provider_payment_id" IS NULL OR "provider" IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- The unique index of 0123 becomes the primary key (no rebuild).
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = '"webhook_events"'::regclass AND conname = 'webhook_events_provider_event_id_pk'
	) THEN
		CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_provider_event_id_key" ON "webhook_events" USING btree ("provider", "event_id");
		ALTER TABLE "webhook_events" DROP CONSTRAINT IF EXISTS "webhook_events_pkey";
		ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_event_id_pk" PRIMARY KEY USING INDEX "webhook_events_provider_event_id_key";
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "provider" DROP DEFAULT;
--> statement-breakpoint
DELETE FROM "settings" WHERE "key" IN ('stripe.preAuthAmountCents', 'stripe.platformFeePercent');
