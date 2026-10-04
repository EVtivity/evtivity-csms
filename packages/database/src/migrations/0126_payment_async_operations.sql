-- Payments P10: async payment operations (Adyen), refund ledger, provider
-- state for authorisation adjustment. Adyen ids never use the stripe_* columns,
-- so saved-method rows may leave them NULL. Every statement is metadata-only
-- (constant defaults, a NOT VALID check, an index on columns that are all NULL).
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "pending_operation" varchar(16);
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "pending_operation_ref" varchar(64);
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "pending_operation_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "provider_refunds" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "provider_state" jsonb;
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ALTER COLUMN "stripe_customer_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ALTER COLUMN "stripe_payment_method_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_pending_operation_check"
    CHECK ("pending_operation" IS NULL OR "pending_operation" IN ('capture', 'cancel', 'adjust')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_records_pending_operation" ON "payment_records" USING btree ("pending_operation_at") WHERE "pending_operation" IS NOT NULL;
