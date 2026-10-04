-- Payments P4: copy the stripe_* ids of existing payment records into the
-- provider columns (the trigger of 0120 derives provider) and rewrite legacy
-- topUpIntentId metadata as topUps. Row locks only; re-runnable.
UPDATE "payment_records"
SET "provider_payment_id" = NULLIF("stripe_payment_intent_id", ''),
	"provider_customer_id" = NULLIF("stripe_customer_id", ''),
	"provider_payment_method_id" = NULLIF("stripe_payment_method_id", '')
WHERE "provider" IS NULL
	AND COALESCE(NULLIF("stripe_payment_intent_id", ''), NULLIF("stripe_customer_id", ''), NULLIF("stripe_payment_method_id", '')) IS NOT NULL;
--> statement-breakpoint
UPDATE "payment_records"
SET "metadata" = evtivity_normalize_top_ups("metadata", "captured_amount_cents", "pre_auth_amount_cents")
WHERE jsonb_typeof("metadata") = 'object' AND "metadata" ? 'topUpIntentId' AND NOT ("metadata" ? 'topUps');
