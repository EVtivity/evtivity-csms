-- Validates the billing mode checks and the billing fleet foreign key that
-- 0170 added NOT VALID. VALIDATE takes a SHARE UPDATE EXCLUSIVE lock (reads
-- and writes continue). Idempotent: each runs only while its constraint is
-- not validated.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_billing_mode_check' AND NOT convalidated
  ) THEN
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_billing_mode_check";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_billing_fleet_check' AND NOT convalidated
  ) THEN
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_billing_fleet_check";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_billing_fleet_id_fleets_id_fk' AND NOT convalidated
  ) THEN
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_billing_fleet_id_fleets_id_fk";
  END IF;
END $$;
