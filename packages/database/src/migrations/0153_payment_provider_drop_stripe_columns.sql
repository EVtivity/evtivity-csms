-- Payments P8 column drop (v0.1.40): drop the stripe_* columns that the
-- provider columns replaced (P4), with their indexes and unique constraint.
-- v0.1.39 stopped reading and writing them (0148 to 0150). Metadata-only
-- (ACCESS EXCLUSIVE for the moment of each ALTER). Pods before v0.1.39 still
-- name these columns, so installs upgrade through v0.1.39, and a rollback
-- below v0.1.39 is not possible after this file.
ALTER TABLE "payment_records" DROP CONSTRAINT IF EXISTS "payment_records_stripe_payment_intent_id_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_payment_records_stripe_payment_intent_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_driver_payment_methods_stripe_customer_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_drivers_stripe_customer_id";
--> statement-breakpoint
ALTER TABLE "payment_records" DROP COLUMN IF EXISTS "stripe_payment_intent_id", DROP COLUMN IF EXISTS "stripe_customer_id", DROP COLUMN IF EXISTS "stripe_payment_method_id";
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" DROP COLUMN IF EXISTS "stripe_customer_id", DROP COLUMN IF EXISTS "stripe_payment_method_id";
--> statement-breakpoint
ALTER TABLE "guest_sessions" DROP COLUMN IF EXISTS "stripe_payment_intent_id";
--> statement-breakpoint
ALTER TABLE "site_payment_configs" DROP COLUMN IF EXISTS "stripe_connected_account_id";
--> statement-breakpoint
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "stripe_customer_id";
