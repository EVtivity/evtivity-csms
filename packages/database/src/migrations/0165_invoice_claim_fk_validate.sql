-- Validates the invoice_id foreign keys 0162 added NOT VALID. VALIDATE takes a
-- SHARE UPDATE EXCLUSIVE lock (reads and writes continue). Idempotent: each
-- runs only while its constraint is not validated.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_invoice_id_invoices_id_fk' AND NOT convalidated
  ) THEN
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_invoice_id_invoices_id_fk";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_records_invoice_id_invoices_id_fk' AND NOT convalidated
  ) THEN
    ALTER TABLE "payment_records" VALIDATE CONSTRAINT "payment_records_invoice_id_invoices_id_fk";
  END IF;
END $$;
