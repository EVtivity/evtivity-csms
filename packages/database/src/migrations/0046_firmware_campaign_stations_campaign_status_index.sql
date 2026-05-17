-- The auto-complete EXISTS check fired from the FirmwareStatusNotification
-- projection (event-projections.ts) scans firmware_campaign_stations by
-- campaign_id filtered to status NOT IN ('installed','failed'). Without the
-- composite index, that ran as a campaign-id range scan followed by an
-- in-memory status filter. Under high-throughput status reports during a
-- multi-hundred-station rollout the filter cost dominated.
CREATE INDEX IF NOT EXISTS "idx_firmware_campaign_stations_campaign_status"
  ON "firmware_campaign_stations" ("campaign_id", "status");
