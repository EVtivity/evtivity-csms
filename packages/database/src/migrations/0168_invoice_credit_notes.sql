-- Credit notes (GoBD): an issued invoice never changes. A credit note, an
-- invoice of kind 'credit_note' with negative amounts, credits it in full and
-- names it in credited_invoice_id (one credit note per invoice).
-- invoice_number_counters numbers invoices and credit notes without gaps: the
-- invoice transaction updates the counter row, so a rollback returns the
-- number, which a sequence never does. The invoice counter starts at the last
-- value of invoice_number_seq. The invoice.CreditNote driver event is on.
-- Metadata and small tables only, idempotent.

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "kind" varchar(16) DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "credited_invoice_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "credit_reason" varchar(500);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_kind_check"
    CHECK ("kind" IN ('invoice', 'credit_note'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_note_reference_check"
    CHECK (("kind" = 'credit_note') = ("credited_invoice_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credited_invoice_id_invoices_id_fk"
    FOREIGN KEY ("credited_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoices_credited_invoice_id" ON "invoices" ("credited_invoice_id") WHERE credited_invoice_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_number_counters" (
  "name" varchar(32) PRIMARY KEY NOT NULL,
  "value" bigint NOT NULL
);--> statement-breakpoint
INSERT INTO "invoice_number_counters" ("name", "value")
SELECT 'invoice', CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM invoice_number_seq
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
INSERT INTO "invoice_number_counters" ("name", "value") VALUES ('credit_note', 0)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
INSERT INTO "driver_event_settings" ("event_type", "is_enabled") VALUES ('invoice.CreditNote', true)
ON CONFLICT ("event_type") DO NOTHING;
