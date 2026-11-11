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
--> statement-breakpoint
-- List sorting (CSMS column headers, `sort` and `order` query params). A sort
-- reads ORDER BY <column> <dir> NULLS LAST, <id> <dir>. A plain ASC index read
-- backward gives DESC NULLS FIRST, so the descending sorts of nullable columns
-- on tables that grow without bound get their own index:
-- charging_sessions started_at (newest charging first) and energy (largest
-- sessions first), access_logs duration (slowest requests first), and the
-- notification log event type. Cost: four concurrent builds, no insert blocked.
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'idx_sessions_started_at_desc',
    'idx_sessions_energy_desc',
    'idx_access_logs_duration_desc',
    'idx_notifications_event_type'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_index
      WHERE indexrelid = to_regclass(name)
        AND NOT indisvalid
    ) THEN
      EXECUTE format('DROP INDEX %I', name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_started_at_desc
  ON charging_sessions (started_at DESC NULLS LAST, id DESC);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_energy_desc
  ON charging_sessions (energy_delivered_wh DESC NULLS LAST, id DESC);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_access_logs_duration_desc
  ON access_logs (duration_ms DESC NULLS LAST, id DESC);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_event_type
  ON notifications (event_type, id);
