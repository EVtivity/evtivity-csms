-- Fleet billing profile: who the fleet invoice goes to and how. Billing
-- contacts (emails), the bill-to block (legal name, address, VAT or tax id),
-- the invoice language, the payment terms (null uses the
-- invoice.paymentTermsDays setting) and auto_invoice (the monthly run bills
-- the fleet; needs a billing contact). Metadata only on a small table,
-- idempotent.

ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_contact_emails" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_legal_name" varchar(255);--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_street" varchar(255);--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_city" varchar(100);--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_state" varchar(100);--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_zip" varchar(20);--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_country" varchar(100);--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "billing_tax_id" varchar(50);--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "invoice_language" varchar(10) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "payment_terms_days" integer;--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "auto_invoice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fleets" ADD CONSTRAINT "fleets_payment_terms_days_check"
    CHECK ("payment_terms_days" IS NULL OR "payment_terms_days" BETWEEN 0 AND 365);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fleets" ADD CONSTRAINT "fleets_auto_invoice_contact_check"
    CHECK (NOT "auto_invoice" OR cardinality("billing_contact_emails") > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
