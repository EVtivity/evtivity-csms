-- OCTT results gain the notApplicable status: the runner reports a test the
-- CSMS PICS excludes as notApplicable and never executes it. The value is
-- added in its own migration so it commits before 0102 runs. Idempotent.

DO $$
BEGIN
  ALTER TYPE octt_test_status ADD VALUE IF NOT EXISTS 'notApplicable';
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;
