-- Reservation hardening (v0.1.45, G5 and G10).
--
-- station_ack_at: when the station accepted ReserveNow. A no-show fee is
-- charged only for a hold the station accepted. The column is backfilled for
-- reservations that are active when it is added: they were accepted under
-- the earlier flow, so no running hold loses its fee. The backfill runs only
-- when the column is created, never again.
--
-- no_show_fee_state: none (no fee), due (the expiry recorded a fee to
-- charge), charged, failed (the charge was declined or could not run),
-- waived (another driver used the EVSE, decision E13). The expiry sets due in
-- the same statement as the status, so a crash before the charge leaves the
-- fee for the next cron run. Idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reservations'
      AND column_name = 'station_ack_at'
  ) THEN
    ALTER TABLE "reservations" ADD COLUMN "station_ack_at" timestamp with time zone;
    UPDATE "reservations" SET "station_ack_at" = "updated_at" WHERE "status" = 'active';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "no_show_fee_state" varchar(10) DEFAULT 'none' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reservations" ADD CONSTRAINT "reservations_no_show_fee_state_check"
    CHECK ("no_show_fee_state" IN ('none', 'due', 'charged', 'failed', 'waived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reservations_no_show_fee_due" ON "reservations" ("updated_at") WHERE "no_show_fee_state" = 'due';
