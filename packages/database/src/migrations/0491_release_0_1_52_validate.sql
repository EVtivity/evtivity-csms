-- evtivity:no-transaction
-- v0.1.52: validates the charging_sessions_charging_kind_check CHECK that
-- 0490_release_0_1_52.sql adds NOT VALID. Inside the 0490 transaction the
-- scan of charging_sessions would run under the ACCESS EXCLUSIVE lock that
-- file's ALTER TABLE statements hold until its commit, so session inserts and
-- updates would wait for the whole scan. Here the statement commits on its
-- own and VALIDATE takes only SHARE UPDATE EXCLUSIVE: reads and writes go on.
-- Runs only while the constraint is not validated, so a rerun takes no lock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_charging_kind_check'
      AND conrelid = 'charging_sessions'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_charging_kind_check";
  END IF;
END $$;
