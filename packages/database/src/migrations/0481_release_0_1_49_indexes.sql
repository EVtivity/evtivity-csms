-- evtivity:no-transaction
-- v0.1.49 index changes over large tables, run CONCURRENTLY so message log
-- inserts go on. The runner applies this file statement by statement outside a
-- transaction and records it only after the last statement succeeded, so a
-- crash halfway reruns the whole file.
--
-- ocpp_message_logs: the API metrics collector counts the inbound Heartbeat
-- frames of the last 24 hours every minute (action, direction, created_at
-- window). With only single-column indexes that count scanned the whole table.
-- Cost: one concurrent build (two table scans), no insert blocked. An install
-- that already holds a valid index of this name skips the build.
-- An INVALID index of the same name (a failed or interrupted concurrent build)
-- is dropped first, since IF NOT EXISTS would keep it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('idx_ocpp_message_logs_action_direction_created_at')
      AND NOT indisvalid
  ) THEN
    DROP INDEX idx_ocpp_message_logs_action_direction_created_at;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ocpp_message_logs_action_direction_created_at
  ON ocpp_message_logs (action, direction, created_at);
