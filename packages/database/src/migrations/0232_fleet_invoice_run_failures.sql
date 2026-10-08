-- Scheduled fleet invoice run (fleet account billing, slice S9). A fleet whose
-- scheduled invoice job failed for good is recorded per fleet and month; the
-- hourly fleet-invoice-run cron claims the rows not reported yet and sends one
-- fleet.InvoiceRunFailed digest per month, and the run skips a recorded month.
-- Idempotent.

CREATE TABLE IF NOT EXISTS "fleet_invoice_run_failures" (
  "fleet_id" text NOT NULL,
  "period_start" date NOT NULL,
  "invoice_number" text,
  "error_message" text NOT NULL,
  "failed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reported_at" timestamp with time zone,
  CONSTRAINT "fleet_invoice_run_failures_pkey" PRIMARY KEY ("fleet_id", "period_start")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fleet_invoice_run_failures" ADD CONSTRAINT "fleet_invoice_run_failures_fleet_id_fleets_id_fk"
    FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fleet_invoice_run_failures_unreported"
  ON "fleet_invoice_run_failures" ("failed_at") WHERE "reported_at" IS NULL;
