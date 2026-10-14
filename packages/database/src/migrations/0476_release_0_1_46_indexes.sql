-- evtivity:no-transaction
-- v0.1.46 unique indexes over large tables, built CONCURRENTLY so meter value
-- and transaction event inserts go on during the build. The runner applies
-- this file statement by statement outside a transaction and records it only
-- after the last statement succeeded, so a crash halfway reruns the whole
-- file. Each CREATE is preceded by a drop of an INVALID index of the same name,
-- which a failed or interrupted concurrent build leaves behind (IF NOT EXISTS
-- would otherwise keep the unusable index).
--
-- meter_values: the dedup key gains station_id, so station-wide readings (no
-- session, no EVSE) of two stations with the same timestamp and measurand no
-- longer collide. Rows unique under the old key are unique under the new one,
-- so no dedup is needed. The old meter_values_dedup_idx stays until the next
-- release: pods of v0.1.45 insert with ON CONFLICT naming its columns and fail
-- without it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('meter_values_station_dedup_idx') AND NOT indisvalid
  ) THEN
    DROP INDEX meter_values_station_dedup_idx;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS meter_values_station_dedup_idx
  ON meter_values (station_id, session_id, evse_id, timestamp, measurand, phase, location)
  NULLS NOT DISTINCT;
--> statement-breakpoint
-- transaction_events: one row per event identity (the resend check's key), so
-- a resend projected on a second OCPP pod while the first delivery is still
-- projecting adds no second row. Resends stored before it are removed first,
-- keeping the earliest row, only while the index is not valid yet.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('uq_transaction_events_event') AND NOT indisvalid
  ) THEN
    DROP INDEX uq_transaction_events_event;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('uq_transaction_events_event') IS NULL THEN
    DELETE FROM transaction_events t
    USING transaction_events d
    WHERE d.session_id = t.session_id
      AND d.event_type = t.event_type
      AND d.seq_no = t.seq_no
      AND d.timestamp = t.timestamp
      AND d.trigger_reason = t.trigger_reason
      AND d.id < t.id;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_transaction_events_event
  ON transaction_events (session_id, event_type, seq_no, timestamp, trigger_reason);
