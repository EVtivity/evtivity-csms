-- The site power chart aggregates Power.Active.Import per minute across all
-- of a site's stations over 24h. The (station_id, measurand, timestamp)
-- index finds the entries, but each value lives on a scattered heap page:
-- ~240k random heap fetches took 35-140s cold on a 22M-row table. Carrying
-- the value in the index makes the aggregate an index-only scan. Replaces
-- the non-covering index from 0073 (same key columns).
CREATE INDEX IF NOT EXISTS "idx_meter_values_station_measurand_ts_cov" ON "meter_values" ("station_id","measurand","timestamp") INCLUDE ("value");--> statement-breakpoint
DROP INDEX IF EXISTS "idx_meter_values_station_measurand_ts";
