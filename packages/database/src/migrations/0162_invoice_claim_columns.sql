-- Invoice claim and mark paid. charging_sessions.invoice_id and
-- payment_records.invoice_id (reservation fee charges) record the one invoice
-- that bills them, claimed in the invoice transaction, so nothing is billed
-- twice and a voided invoice releases what it billed. The foreign keys are
-- added NOT VALID and validated by 0165. invoices.paid_at and
-- payment_reference record when and how an invoice was paid.
-- invoice_audit_log records operator actions on invoices. Metadata only,
-- idempotent.

ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "invoice_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_invoice_id_invoices_id_fk"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN IF NOT EXISTS "invoice_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_invoice_id_invoices_id_fk"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payment_reference" varchar(200);--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "invoice_audit_action" AS ENUM ('marked_paid', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "invoice_id" text,
  "invoice_id_snapshot" text NOT NULL,
  "action" "invoice_audit_action" NOT NULL,
  "actor" "audit_actor" NOT NULL,
  "actor_user_id" text,
  "actor_driver_id" text,
  "actor_api_key_id" text,
  "actor_label" varchar(100),
  "before" jsonb,
  "after" jsonb,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_audit_invoice_id" ON "invoice_audit_log" ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_audit_created_at" ON "invoice_audit_log" ("created_at");
