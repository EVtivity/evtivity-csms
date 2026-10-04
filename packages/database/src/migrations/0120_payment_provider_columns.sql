-- Payments P4 (expand): provider-neutral payment columns next to the stripe_*
-- columns, driver_payment_customers, and triggers that copy what pods of the
-- previous release write into the new columns. P8 drops the old columns, the
-- triggers and the functions. Metadata-only: no row is rewritten here.
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "provider" varchar(32);
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "provider_payment_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "provider_customer_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "provider_payment_method_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ADD COLUMN IF NOT EXISTS "provider" varchar(32);
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ADD COLUMN IF NOT EXISTS "provider_customer_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ADD COLUMN IF NOT EXISTS "provider_payment_method_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN IF NOT EXISTS "provider" varchar(32);
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN IF NOT EXISTS "provider_payment_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "site_payment_configs" ADD COLUMN IF NOT EXISTS "payout_account_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN IF NOT EXISTS "provider" varchar(32) DEFAULT 'stripe' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_payment_customers" (
	"driver_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_customer_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_payment_customers_driver_id_provider_pk" PRIMARY KEY ("driver_id", "provider")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "driver_payment_customers" ADD CONSTRAINT "driver_payment_customers_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- The provider that minted a stored id, the rule pinning.ts used before P4:
-- the simulated provider's prefixes, else Stripe. NULL when no id is set.
CREATE OR REPLACE FUNCTION "evtivity_payment_provider_of"(VARIADIC ids text[]) RETURNS varchar
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN EXISTS (SELECT 1 FROM unnest(ids) AS i WHERE i LIKE 'cus\_sim\_%' OR i LIKE 'pm\_sim\_%' OR i LIKE 'pi\_sim\_%') THEN 'simulated'
		WHEN EXISTS (SELECT 1 FROM unnest(ids) AS i WHERE NULLIF(i, '') IS NOT NULL) THEN 'stripe'
	END
$$;
--> statement-breakpoint
-- A legacy settlement top-up (metadata.topUpIntentId, writers before
-- v0.1.37) as metadata.topUps, with the rule of top-ups.ts topUpCharges.
CREATE OR REPLACE FUNCTION "evtivity_normalize_top_ups"(meta jsonb, captured integer, pre_auth integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN meta IS NULL OR jsonb_typeof(meta) <> 'object' OR NOT (meta ? 'topUpIntentId') OR (meta ? 'topUps') THEN meta
		WHEN NULLIF(meta ->> 'topUpIntentId', '') IS NULL
			OR COALESCE(captured, 0) - LEAST(COALESCE(captured, 0), COALESCE(pre_auth, captured, 0)) <= 0
			THEN jsonb_set(meta - 'topUpIntentId', '{topUps}', '[]'::jsonb)
		ELSE jsonb_set(meta - 'topUpIntentId', '{topUps}', jsonb_build_array(jsonb_build_object(
			'paymentId', meta ->> 'topUpIntentId',
			'amountCents', COALESCE(captured, 0) - LEAST(COALESCE(captured, 0), COALESCE(pre_auth, captured, 0)),
			'refundedCents', 0)))
	END
$$;
--> statement-breakpoint
-- Copies an old column into its new column when the writer set only the old
-- one (a pod of the previous release). A writer that sets both (this
-- release) is left alone.
CREATE OR REPLACE FUNCTION "payment_records_provider_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW.provider_payment_id := COALESCE(NEW.provider_payment_id, NULLIF(NEW.stripe_payment_intent_id, ''));
		NEW.provider_customer_id := COALESCE(NEW.provider_customer_id, NULLIF(NEW.stripe_customer_id, ''));
		NEW.provider_payment_method_id := COALESCE(NEW.provider_payment_method_id, NULLIF(NEW.stripe_payment_method_id, ''));
	ELSE
		IF NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id AND NEW.provider_payment_id IS NOT DISTINCT FROM OLD.provider_payment_id THEN
			NEW.provider_payment_id := NULLIF(NEW.stripe_payment_intent_id, '');
		END IF;
		IF NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id AND NEW.provider_customer_id IS NOT DISTINCT FROM OLD.provider_customer_id THEN
			NEW.provider_customer_id := NULLIF(NEW.stripe_customer_id, '');
		END IF;
		IF NEW.stripe_payment_method_id IS DISTINCT FROM OLD.stripe_payment_method_id AND NEW.provider_payment_method_id IS NOT DISTINCT FROM OLD.provider_payment_method_id THEN
			NEW.provider_payment_method_id := NULLIF(NEW.stripe_payment_method_id, '');
		END IF;
	END IF;
	IF NEW.provider IS NULL THEN
		NEW.provider := evtivity_payment_provider_of(NEW.provider_payment_id, NEW.provider_customer_id, NEW.provider_payment_method_id);
	END IF;
	NEW.metadata := evtivity_normalize_top_ups(NEW.metadata, NEW.captured_amount_cents, NEW.pre_auth_amount_cents);
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "payment_records_provider_sync" BEFORE INSERT OR UPDATE ON "payment_records" FOR EACH ROW EXECUTE FUNCTION "payment_records_provider_sync"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "driver_payment_methods_provider_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW.provider_customer_id := COALESCE(NEW.provider_customer_id, NULLIF(NEW.stripe_customer_id, ''));
		NEW.provider_payment_method_id := COALESCE(NEW.provider_payment_method_id, NULLIF(NEW.stripe_payment_method_id, ''));
	ELSE
		IF NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id AND NEW.provider_customer_id IS NOT DISTINCT FROM OLD.provider_customer_id THEN
			NEW.provider_customer_id := NULLIF(NEW.stripe_customer_id, '');
		END IF;
		IF NEW.stripe_payment_method_id IS DISTINCT FROM OLD.stripe_payment_method_id AND NEW.provider_payment_method_id IS NOT DISTINCT FROM OLD.provider_payment_method_id THEN
			NEW.provider_payment_method_id := NULLIF(NEW.stripe_payment_method_id, '');
		END IF;
	END IF;
	IF NEW.provider IS NULL THEN
		NEW.provider := evtivity_payment_provider_of(NEW.provider_customer_id, NEW.provider_payment_method_id);
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "driver_payment_methods_provider_sync" BEFORE INSERT OR UPDATE ON "driver_payment_methods" FOR EACH ROW EXECUTE FUNCTION "driver_payment_methods_provider_sync"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guest_sessions_provider_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW.provider_payment_id := COALESCE(NEW.provider_payment_id, NULLIF(NEW.stripe_payment_intent_id, ''));
	ELSIF NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id AND NEW.provider_payment_id IS NOT DISTINCT FROM OLD.provider_payment_id THEN
		NEW.provider_payment_id := NULLIF(NEW.stripe_payment_intent_id, '');
	END IF;
	IF NEW.provider IS NULL THEN
		NEW.provider := evtivity_payment_provider_of(NEW.provider_payment_id);
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "guest_sessions_provider_sync" BEFORE INSERT OR UPDATE ON "guest_sessions" FOR EACH ROW EXECUTE FUNCTION "guest_sessions_provider_sync"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "site_payment_configs_payout_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW.payout_account_id := COALESCE(NEW.payout_account_id, NULLIF(NEW.stripe_connected_account_id, ''));
	ELSIF NEW.stripe_connected_account_id IS DISTINCT FROM OLD.stripe_connected_account_id AND NEW.payout_account_id IS NOT DISTINCT FROM OLD.payout_account_id THEN
		NEW.payout_account_id := NULLIF(NEW.stripe_connected_account_id, '');
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "site_payment_configs_payout_sync" BEFORE INSERT OR UPDATE ON "site_payment_configs" FOR EACH ROW EXECUTE FUNCTION "site_payment_configs_payout_sync"();
--> statement-breakpoint
-- A customer id set on the driver row (by any release) is the driver's
-- customer of the provider that minted it.
CREATE OR REPLACE FUNCTION "drivers_payment_customer_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "driver_payment_customers" ("driver_id", "provider", "provider_customer_id")
	VALUES (NEW.id, evtivity_payment_provider_of(NEW.stripe_customer_id), NEW.stripe_customer_id)
	ON CONFLICT ("driver_id", "provider") DO UPDATE
	SET "provider_customer_id" = EXCLUDED."provider_customer_id", "updated_at" = now()
	WHERE "driver_payment_customers"."provider_customer_id" IS DISTINCT FROM EXCLUDED."provider_customer_id";
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "drivers_payment_customer_sync" AFTER INSERT OR UPDATE OF "stripe_customer_id" ON "drivers" FOR EACH ROW WHEN (NULLIF(NEW.stripe_customer_id, '') IS NOT NULL) EXECUTE FUNCTION "drivers_payment_customer_sync"();
