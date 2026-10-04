-- Payments P4: merge saved methods a driver saved twice (the oldest row is
-- kept, with the default flag of the group), copy the stripe_* ids of saved
-- methods, guest sessions and site payout accounts into the provider
-- columns, and fill driver_payment_customers from the driver row, else from
-- the driver's earliest saved method of each provider. Re-runnable.
WITH "groups" AS (
	SELECT "driver_id", "stripe_payment_method_id", min("id") AS "keep_id", bool_or("is_default") AS "any_default"
	FROM "driver_payment_methods"
	GROUP BY "driver_id", "stripe_payment_method_id"
	HAVING count(*) > 1
)
UPDATE "driver_payment_methods" m SET "is_default" = true
FROM "groups" g
WHERE m."id" = g."keep_id" AND g."any_default" AND NOT m."is_default";
--> statement-breakpoint
DELETE FROM "driver_payment_methods" d
USING "driver_payment_methods" k
WHERE d."driver_id" = k."driver_id" AND d."stripe_payment_method_id" = k."stripe_payment_method_id" AND d."id" > k."id";
--> statement-breakpoint
UPDATE "driver_payment_methods"
SET "provider_customer_id" = NULLIF("stripe_customer_id", ''),
	"provider_payment_method_id" = NULLIF("stripe_payment_method_id", '')
WHERE "provider" IS NULL;
--> statement-breakpoint
UPDATE "guest_sessions"
SET "provider_payment_id" = NULLIF("stripe_payment_intent_id", '')
WHERE "provider" IS NULL AND NULLIF("stripe_payment_intent_id", '') IS NOT NULL;
--> statement-breakpoint
UPDATE "site_payment_configs"
SET "payout_account_id" = NULLIF("stripe_connected_account_id", '')
WHERE "payout_account_id" IS NULL AND NULLIF("stripe_connected_account_id", '') IS NOT NULL;
--> statement-breakpoint
INSERT INTO "driver_payment_customers" ("driver_id", "provider", "provider_customer_id")
SELECT "id", evtivity_payment_provider_of("stripe_customer_id"), "stripe_customer_id"
FROM "drivers"
WHERE NULLIF("stripe_customer_id", '') IS NOT NULL
ON CONFLICT ("driver_id", "provider") DO NOTHING;
--> statement-breakpoint
INSERT INTO "driver_payment_customers" ("driver_id", "provider", "provider_customer_id")
SELECT DISTINCT ON ("driver_id", "provider") "driver_id", "provider", "provider_customer_id"
FROM "driver_payment_methods"
WHERE "provider" IS NOT NULL AND "provider_customer_id" IS NOT NULL
ORDER BY "driver_id", "provider", "created_at", "id"
ON CONFLICT ("driver_id", "provider") DO NOTHING;
