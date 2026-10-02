-- An EVSE number is unique per station and a connector number per EVSE.
-- Concurrent status reports could create duplicates; any that exist are merged
-- onto the oldest row before the unique indexes are added.
CREATE TEMP TABLE evse_merge ON COMMIT DROP AS
SELECT e.id AS dup_id, k.keep_id
FROM evses e
JOIN (
  SELECT DISTINCT ON (station_id, evse_id) station_id, evse_id, id AS keep_id
  FROM evses
  ORDER BY station_id, evse_id, created_at, id
) k ON k.station_id = e.station_id AND k.evse_id = e.evse_id
WHERE e.id <> k.keep_id;
--> statement-breakpoint
UPDATE connectors c SET evse_id = m.keep_id FROM evse_merge m WHERE c.evse_id = m.dup_id;
--> statement-breakpoint
UPDATE charging_sessions s SET evse_id = m.keep_id FROM evse_merge m WHERE s.evse_id = m.dup_id;
--> statement-breakpoint
UPDATE reservations r SET evse_id = m.keep_id FROM evse_merge m WHERE r.evse_id = m.dup_id;
--> statement-breakpoint
-- meter_values has no evse_id index, so it is only touched when there is a
-- duplicate to merge. A reading that already exists on the kept EVSE is a
-- duplicate and is dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM evse_merge) THEN
    DELETE FROM meter_values v
    USING evse_merge m
    WHERE v.evse_id = m.dup_id
      AND EXISTS (
        SELECT 1 FROM meter_values k
        WHERE k.evse_id = m.keep_id
          AND k.session_id IS NOT DISTINCT FROM v.session_id
          AND k.timestamp = v.timestamp
          AND k.measurand IS NOT DISTINCT FROM v.measurand
          AND k.phase IS NOT DISTINCT FROM v.phase
          AND k.location IS NOT DISTINCT FROM v.location
      );
    UPDATE meter_values v SET evse_id = m.keep_id FROM evse_merge m WHERE v.evse_id = m.dup_id;
  END IF;
END $$;
--> statement-breakpoint
DELETE FROM evses e USING evse_merge m WHERE e.id = m.dup_id;
--> statement-breakpoint
CREATE TEMP TABLE connector_merge ON COMMIT DROP AS
SELECT c.id AS dup_id, k.keep_id
FROM connectors c
JOIN (
  SELECT DISTINCT ON (evse_id, connector_id) evse_id, connector_id, id AS keep_id
  FROM connectors
  ORDER BY evse_id, connector_id, created_at, id
) k ON k.evse_id = c.evse_id AND k.connector_id = c.connector_id
WHERE c.id <> k.keep_id;
--> statement-breakpoint
UPDATE charging_sessions s SET connector_id = m.keep_id FROM connector_merge m WHERE s.connector_id = m.dup_id;
--> statement-breakpoint
UPDATE reservations r SET connector_id = m.keep_id FROM connector_merge m WHERE r.connector_id = m.dup_id;
--> statement-breakpoint
DELETE FROM connectors c USING connector_merge m WHERE c.id = m.dup_id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_evses_station_evse" ON "evses" ("station_id", "evse_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_connectors_evse_connector" ON "connectors" ("evse_id", "connector_id");
