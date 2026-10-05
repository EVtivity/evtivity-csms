-- Queued commands belong to their station (OCPP station id): deleting the
-- station deletes them, and a station id change carries them along. Before,
-- the queue had no FK, so the commands of a deleted station stayed pending
-- until they expired (OCTT deletes its test stations after every run).
-- Rows of stations that no longer exist are removed first, so the constraint
-- validates. The queue holds at most a day of commands (offline TTL).
DELETE FROM "offline_command_queue" q
WHERE NOT EXISTS (
  SELECT 1 FROM "charging_stations" s WHERE s."station_id" = q."station_id"
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "offline_command_queue"
    ADD CONSTRAINT "offline_command_queue_station_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "charging_stations"("station_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
