-- evtivity:no-transaction
-- v0.1.49 index changes over large tables, second file, run CONCURRENTLY so
-- inserts go on. The runner applies this file statement by statement outside
-- a transaction and records it only after the last statement succeeded, so a
-- crash halfway reruns the whole file.
--
-- transaction_events: the API metrics collector counts the events of the last
-- 24 hours by trigger reason every minute (created_at window). created_at had
-- no index, so that count scanned the whole table.
-- Cost: one concurrent build (two table scans), no insert blocked.
-- An INVALID index of the same name (a failed or interrupted concurrent build)
-- is dropped first, since IF NOT EXISTS would keep it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('idx_transaction_events_created_at')
      AND NOT indisvalid
  ) THEN
    DROP INDEX idx_transaction_events_created_at;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_events_created_at
  ON transaction_events (created_at);
--> statement-breakpoint
-- ocpp_message_logs: idx_ocpp_message_logs_action is a prefix of
-- idx_ocpp_message_logs_action_direction_created_at (0481), which serves every
-- action-only filter, so it is only insert overhead. Station-scoped action
-- reads use idx_ocpp_message_logs_station_action.
-- Cost: no table scan or rewrite; DROP INDEX CONCURRENTLY waits for the
-- transactions using the table to end and blocks no insert.
DROP INDEX CONCURRENTLY IF EXISTS idx_ocpp_message_logs_action;
