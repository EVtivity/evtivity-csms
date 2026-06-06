-- Composite index for latest-reading-per-session lookups:
--   WHERE session_id = ? AND measurand = ? ORDER BY timestamp DESC LIMIT 1
-- (station-message power refresh, session meter views). Without it the
-- planner walks idx_meter_values_timestamp backwards with a filter, scanning
-- the entire index when a session has no matching measurand rows; concurrent
-- refreshes saturate the API connection pool.
CREATE INDEX IF NOT EXISTS "idx_meter_values_session_measurand_ts"
  ON "meter_values" ("session_id", "measurand", "timestamp");
