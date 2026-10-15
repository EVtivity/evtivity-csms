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
--> statement-breakpoint
-- charging_sessions: site revenue, metrics and reports read sessions by the
-- site they happened at (site_id, 0475) and their start.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('idx_sessions_site_started_at') AND NOT indisvalid
  ) THEN
    DROP INDEX idx_sessions_site_started_at;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_site_started_at
  ON charging_sessions (site_id, started_at);

--> statement-breakpoint
-- beta.8 ocpi
-- lane E: received OCPI data is stored once. ocpi_cdrs and
-- ocpi_roaming_sessions hold rows partners send us (charging_session_id null)
-- next to our own CPO rows; a received CDR or session is one row per partner
-- and OCPI id, so a resend or two concurrent PUTs or POSTs do not add a second
-- row (the receivers and the CDR pull insert with ON CONFLICT on these
-- indexes). Duplicates stored before are removed first, only while the index
-- is missing: for CDRs (immutable) the earliest row is kept, for sessions the
-- most recently updated one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('uq_ocpi_cdrs_received') AND NOT indisvalid
  ) THEN
    DROP INDEX uq_ocpi_cdrs_received;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('uq_ocpi_cdrs_received') IS NULL THEN
    DELETE FROM ocpi_cdrs t
    USING ocpi_cdrs d
    WHERE d.partner_id = t.partner_id
      AND d.ocpi_cdr_id = t.ocpi_cdr_id
      AND d.charging_session_id IS NULL
      AND t.charging_session_id IS NULL
      AND d.id < t.id;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_ocpi_cdrs_received
  ON ocpi_cdrs (partner_id, ocpi_cdr_id)
  WHERE charging_session_id IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('uq_ocpi_roaming_sessions_received') AND NOT indisvalid
  ) THEN
    DROP INDEX uq_ocpi_roaming_sessions_received;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('uq_ocpi_roaming_sessions_received') IS NULL THEN
    DELETE FROM ocpi_roaming_sessions t
    USING ocpi_roaming_sessions d
    WHERE d.partner_id = t.partner_id
      AND d.ocpi_session_id = t.ocpi_session_id
      AND d.charging_session_id IS NULL
      AND t.charging_session_id IS NULL
      AND (d.updated_at > t.updated_at OR (d.updated_at = t.updated_at AND d.id > t.id));
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_ocpi_roaming_sessions_received
  ON ocpi_roaming_sessions (partner_id, ocpi_session_id)
  WHERE charging_session_id IS NULL;
-- end beta.8 ocpi
--> statement-breakpoint
-- beta.8 sessions
-- charging_sessions: the portal session list pages a driver's sessions newest
-- first (created_at DESC, id DESC); without this index every page sorts all
-- of the driver's sessions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('idx_sessions_driver_created') AND NOT indisvalid
  ) THEN
    DROP INDEX idx_sessions_driver_created;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_driver_created
  ON charging_sessions (driver_id, created_at DESC, id DESC);
--> statement-breakpoint
-- payment_records: payment_records_session_id_unique already indexes
-- session_id, so the plain index only costs writes.
DROP INDEX CONCURRENTLY IF EXISTS idx_payment_records_session_id;
--> statement-breakpoint
-- guest_sessions: one guest checkout per charging session (a guest is linked
-- by its own session token, so a session never has two). The unique index
-- replaces the plain one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('uq_guest_sessions_charging_session') AND NOT indisvalid
  ) THEN
    DROP INDEX uq_guest_sessions_charging_session;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_guest_sessions_charging_session
  ON guest_sessions (charging_session_id);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS idx_guest_sessions_charging_session;
-- end beta.8 sessions
--> statement-breakpoint
-- meter_values: deleting an EVSE (a station delete cascades to its EVSEs)
-- checks the evse_id foreign key, which scanned the whole table without an
-- index on it. The end-of-run delete of conformance test stations took
-- minutes, and longer on a large table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('idx_meter_values_evse_id') AND NOT indisvalid
  ) THEN
    DROP INDEX idx_meter_values_evse_id;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meter_values_evse_id
  ON meter_values (evse_id)
  WHERE evse_id IS NOT NULL;
-- end conformance stations
