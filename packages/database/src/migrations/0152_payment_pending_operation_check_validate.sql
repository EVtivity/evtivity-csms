-- Validates payment_records_pending_operation_check, which 0126 added NOT VALID
-- for the rolling upgrade of v0.1.38 and no later migration validated. VALIDATE
-- takes SHARE UPDATE EXCLUSIVE, so payment reads and writes continue while it
-- scans payment_records. Runs only while the check is not yet valid, so a
-- re-run takes no lock. Existing rows hold: 0126 added the column in the same
-- file, and every write since then is checked.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_records_pending_operation_check'
      AND conrelid = 'payment_records'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE "payment_records" VALIDATE CONSTRAINT "payment_records_pending_operation_check";
  END IF;
END $$;
