-- Fleet credit limit notices record the exposure and the limit at the time
-- of the notice. A fleet's exposure is a sum of session costs and can pass
-- the integer range, so both columns are bigint. Idempotent: each ALTER runs
-- only while the column is still integer.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'fleet_credit_limit_notices'
      AND column_name = 'exposure_cents'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE "fleet_credit_limit_notices" ALTER COLUMN "exposure_cents" TYPE bigint;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'fleet_credit_limit_notices'
      AND column_name = 'limit_cents'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE "fleet_credit_limit_notices" ALTER COLUMN "limit_cents" TYPE bigint;
  END IF;
END $$;
