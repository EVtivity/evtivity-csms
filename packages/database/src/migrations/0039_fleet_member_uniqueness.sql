-- Enforce one-row-per-(fleet, member) for fleet_drivers and fleet_stations.
-- Without these constraints, POST /v1/fleets/:id/drivers and
-- POST /v1/fleets/:id/stations were silently inserting duplicate rows on
-- repeated calls. Schema mirror in packages/database/src/schema/drivers.ts.
--
-- The CTE first deletes pre-existing duplicates, keeping the row with the
-- smallest id per (fleet_id, driver_id) / (fleet_id, station_id) pair, so
-- the unique index can be added without blowing up on legacy data.

WITH duplicates AS (
  SELECT id,
         row_number() OVER (PARTITION BY fleet_id, driver_id ORDER BY id) AS rn
  FROM fleet_drivers
)
DELETE FROM fleet_drivers
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

ALTER TABLE fleet_drivers
  ADD CONSTRAINT uq_fleet_drivers_fleet_driver UNIQUE (fleet_id, driver_id);

WITH duplicates AS (
  SELECT id,
         row_number() OVER (PARTITION BY fleet_id, station_id ORDER BY id) AS rn
  FROM fleet_stations
)
DELETE FROM fleet_stations
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

ALTER TABLE fleet_stations
  ADD CONSTRAINT uq_fleet_stations_fleet_station UNIQUE (fleet_id, station_id);
