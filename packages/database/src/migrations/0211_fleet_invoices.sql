-- Fleet invoice (fleet account billing, slice S5). A fleet invoice bills the
-- fleet's sessions billed on account for one calendar month (system
-- timezone): fleet_id, the period (first and last day), the bill-to block and
-- language of the fleet billing profile at issue (snapshot, GoBD), and
-- sent_at, when the invoice email last went to the billing contacts (the
-- marker that sends it once per issue). One live invoice per fleet and period:
-- a credited or void one frees the period. A credit note of a fleet invoice
-- carries the same fleet and period. Metadata and an index on a small table,
-- idempotent.

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fleet_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "period_start" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "period_end" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "bill_to" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "language" varchar(10);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fleet_id_fleets_id_fk"
    FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fleet_period_check"
    CHECK ("fleet_id" IS NULL OR ("period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" >= "period_start"));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoices_fleet_id" ON "invoices" ("fleet_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoices_fleet_period" ON "invoices" ("fleet_id", "period_start") WHERE fleet_id IS NOT NULL AND kind = 'invoice' AND status NOT IN ('void', 'credited');
