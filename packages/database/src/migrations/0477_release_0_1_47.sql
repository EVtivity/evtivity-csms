-- v0.1.47 release migration. One file per release: extended in place during the
-- release cycle, every statement idempotent.

-- Invoice payment information (issue #42): the bank details printed in the
-- "Payment information" block of invoice PDFs and the EPC QR code switch. The
-- bank details start empty (no block without an IBAN); the QR code is on.
-- ON CONFLICT DO NOTHING keeps an operator value.
INSERT INTO "settings" ("key", "value") VALUES
  ('company.bankAccountHolder', '""'::jsonb),
  ('company.iban', '""'::jsonb),
  ('company.bic', '""'::jsonb),
  ('company.bankName', '""'::jsonb),
  ('invoice.epcQrEnabled', 'true'::jsonb)
ON CONFLICT ("key") DO NOTHING;

-- Fleet invoice date (discussion #12): run_date (the issue day, as before) or
-- period_end (the last day of the billed month).
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "invoice_date_mode" varchar(16) DEFAULT 'run_date' NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleets_invoice_date_mode_check'
  ) THEN
    ALTER TABLE "fleets" ADD CONSTRAINT "fleets_invoice_date_mode_check"
      CHECK ("invoice_date_mode" IN ('run_date', 'period_end'));
  END IF;
END $$;

-- Session billing recipient moves (discussion #12). Written by code only; no
-- statement of this file uses the value.
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'billing_reassigned';
