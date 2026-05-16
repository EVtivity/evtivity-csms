ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "stripe_customer_id" varchar(255);
--> statement-breakpoint
-- Backfill stripe_customer_id from any existing saved payment method so the
-- save-payment-method ownership check works on first call for drivers who
-- already had cards on file before this column existed.
UPDATE drivers d
SET stripe_customer_id = pm.stripe_customer_id
FROM (
  SELECT DISTINCT ON (driver_id) driver_id, stripe_customer_id
  FROM driver_payment_methods
  ORDER BY driver_id, is_default DESC, created_at ASC
) pm
WHERE d.id = pm.driver_id AND d.stripe_customer_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_drivers_stripe_customer_id"
  ON "drivers" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;
