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
--> statement-breakpoint
-- Card ids match regardless of letter case (OCPP idTokens are case-insensitive),
-- so station lookups compare lower(id_token) and lower(uid). Built
-- concurrently: card inserts and updates go on. An INVALID index left by a
-- failed or interrupted build is dropped first, so IF NOT EXISTS rebuilds it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_driver_tokens_id_token_lower' AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX "idx_driver_tokens_id_token_lower"';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_driver_tokens_id_token_lower" ON "driver_tokens" (lower("id_token"));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_ocpi_external_tokens_uid_lower' AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX "idx_ocpi_external_tokens_uid_lower"';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ocpi_external_tokens_uid_lower" ON "ocpi_external_tokens" (lower("uid"));
