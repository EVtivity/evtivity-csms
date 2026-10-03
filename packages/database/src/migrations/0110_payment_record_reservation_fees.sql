-- Reservation cancellation and no-show fees become payment records (issue #33,
-- N20): taxed at the station tariff's rate, routed through Stripe Connect, and
-- counted in revenue. Session records keep charge_type 'session'.
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "charge_type" varchar(30) DEFAULT 'session' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "reservation_id" text;
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "tax_rate" numeric;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_charge_type_check" CHECK ("charge_type" IN ('session', 'reservation_cancellation', 'reservation_no_show'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_records_reservation_charge" ON "payment_records" USING btree ("reservation_id","charge_type") WHERE "payment_records"."reservation_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "payment_record_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_payment_record_id_payment_records_id_fk" FOREIGN KEY ("payment_record_id") REFERENCES "public"."payment_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_line_items_payment_record_id" ON "invoice_line_items" USING btree ("payment_record_id");
