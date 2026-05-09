-- Dedupe firmware_updates rows that share (station_id, request_id) before
-- creating the partial unique index. Duplicates can exist on databases that
-- ran the buggy projection (which inserted "unknown" rows when status
-- notifications could not be correlated by request_id). Keep the row with
-- campaign_id set when present (richer data), otherwise the oldest row.
DELETE FROM firmware_updates fu
USING (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY station_id, request_id
        ORDER BY
          (campaign_id IS NOT NULL) DESC,
          created_at ASC,
          id ASC
      ) AS rn
    FROM firmware_updates
    WHERE request_id IS NOT NULL
  ) ranked
  WHERE rn > 1
) dups
WHERE fu.id = dups.id;

-- Partial unique index on firmware_updates(station_id, request_id) where
-- request_id is not null. Required for ON CONFLICT upsert in the
-- command.UpdateFirmware projection so concurrent dispatches and the API's
-- pre-insert cannot produce duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_firmware_updates_station_request
  ON firmware_updates (station_id, request_id)
  WHERE request_id IS NOT NULL;
