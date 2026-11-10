-- evtivity:no-transaction
-- v0.1.51 index over a table that can be large, run CONCURRENTLY so inserts go
-- on. The runner applies this file statement by statement outside a
-- transaction and records it only after the last statement succeeded, so a
-- crash halfway reruns the whole file.
--
-- security_events: the dashboard Security Events card, the critical event
-- gauge and the security event retention prune filter by the server receipt
-- time (created_at, never the station-reported timestamp). A station may send
-- events fast and the table keeps up to 3650 days, so a plain build in the
-- file transaction would hold back every SecurityEventNotification insert.
-- Cost: one concurrent build (two table scans), no insert blocked.
-- An INVALID index of the same name (a failed or interrupted concurrent build)
-- is dropped first, since IF NOT EXISTS would keep it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('idx_security_events_created_at')
      AND NOT indisvalid
  ) THEN
    DROP INDEX idx_security_events_created_at;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_security_events_created_at
  ON security_events (created_at);
--> statement-breakpoint
-- port_status_log: the port status retention prune filters by the server
-- receipt time (created_at, never the station-reported timestamp: a status
-- dated 2000 would be pruned at once, one dated 2100 never). Every status
-- change of every connector adds a row, so the build runs concurrently too.
-- Cost: one concurrent build (two table scans), no insert blocked.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('idx_port_status_log_created_at')
      AND NOT indisvalid
  ) THEN
    DROP INDEX idx_port_status_log_created_at;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_port_status_log_created_at
  ON port_status_log (created_at);
