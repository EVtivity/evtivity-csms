-- The station Meter Values tab lists standalone (non-session) readings:
-- WHERE station_id = ? AND session_id IS NULL ORDER BY timestamp DESC LIMIT n.
-- Without a matching index the planner walks idx_meter_values_timestamp
-- backwards across the entire table filtering row by row (measured 42s on a
-- 22M-row table for a station with no standalone readings). The partial
-- index serves both the page query and the count.
CREATE INDEX IF NOT EXISTS "idx_meter_values_station_standalone_ts" ON "meter_values" ("station_id","timestamp") WHERE session_id IS NULL;
