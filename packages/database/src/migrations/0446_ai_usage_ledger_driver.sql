-- Driver AI support (plan v0.1.45, section 2.4): the ledger records the
-- driver a driver_support call ran for (the driver daily budget) and the
-- support case (provenance, no foreign key, like the other provenance ids).
-- Idempotent.
ALTER TABLE "ai_usage_ledger" ADD COLUMN IF NOT EXISTS "driver_id" text;
--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN IF NOT EXISTS "support_case_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_driver_id_drivers_id_fk"
    FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" DROP CONSTRAINT IF EXISTS "ai_usage_ledger_surface_check";
--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_surface_check"
  CHECK ("surface" IN ('chatbot', 'support', 'insight', 'insight_translation', 'worker', 'driver_support'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_ledger_driver_occurred_at"
  ON "ai_usage_ledger" ("driver_id", "occurred_at");
