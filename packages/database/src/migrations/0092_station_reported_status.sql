-- A station reports its own status as OCPP 1.6 connector 0 or OCPP 2.x
-- NotifyEvent ChargingStation AvailabilityState. It is kept on the station, not
-- as an EVSE 0 / connector 0 row that looked like a plug. Existing EVSE 0 rows
-- hand their status to the station and are removed.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "reported_status" "charging_station_status";
--> statement-breakpoint
UPDATE "charging_stations" cs
SET "reported_status" = (CASE c."status"
    WHEN 'faulted' THEN 'faulted'
    WHEN 'unavailable' THEN 'unavailable'
    ELSE 'available'
  END)::"charging_station_status"
FROM "evses" e
JOIN "connectors" c ON c."evse_id" = e."id"
WHERE e."station_id" = cs."id"
  AND e."evse_id" = 0
  AND cs."reported_status" IS NULL;
--> statement-breakpoint
UPDATE "charging_sessions" SET "connector_id" = NULL
WHERE "connector_id" IN (
  SELECT c."id" FROM "connectors" c JOIN "evses" e ON e."id" = c."evse_id" WHERE e."evse_id" = 0
);
--> statement-breakpoint
UPDATE "charging_sessions" SET "evse_id" = NULL
WHERE "evse_id" IN (SELECT "id" FROM "evses" WHERE "evse_id" = 0);
--> statement-breakpoint
-- meter_values has no evse_id index, so it is only scanned when EVSE 0 rows exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "evses" WHERE "evse_id" = 0) THEN
    UPDATE "meter_values" SET "evse_id" = NULL
    WHERE "evse_id" IN (SELECT "id" FROM "evses" WHERE "evse_id" = 0);
  END IF;
END $$;
--> statement-breakpoint
UPDATE "reservations" SET "connector_id" = NULL
WHERE "connector_id" IN (
  SELECT c."id" FROM "connectors" c JOIN "evses" e ON e."id" = c."evse_id" WHERE e."evse_id" = 0
);
--> statement-breakpoint
UPDATE "reservations" SET "evse_id" = NULL
WHERE "evse_id" IN (SELECT "id" FROM "evses" WHERE "evse_id" = 0);
--> statement-breakpoint
DELETE FROM "evses" WHERE "evse_id" = 0;
