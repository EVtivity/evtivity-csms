-- evtivity:no-transaction
-- v0.1.53: validates the charging_sessions_ev_phases_check CHECK that
-- 0492_release_0_1_53.sql adds NOT VALID. Inside the 0492 transaction the scan
-- of charging_sessions would run under the ACCESS EXCLUSIVE lock that file's
-- ALTER TABLE statements hold until its commit. Here the statement commits on
-- its own and VALIDATE takes only SHARE UPDATE EXCLUSIVE: reads and writes go
-- on. Runs only while the constraint is not validated, so a rerun takes no lock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_ev_phases_check'
      AND conrelid = 'charging_sessions'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_ev_phases_check";
  END IF;
END $$;
--> statement-breakpoint
-- The same for load_allocation_log_kind_check.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'load_allocation_log_kind_check'
      AND conrelid = 'load_allocation_log'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE "load_allocation_log" VALIDATE CONSTRAINT "load_allocation_log_kind_check";
  END IF;
END $$;
