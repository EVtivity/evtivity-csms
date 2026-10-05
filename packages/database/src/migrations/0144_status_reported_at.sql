-- The station's own timestamp of the stored connector status and of the status
-- the station reports for itself. A status write applies only when its
-- timestamp is not older than the stored one, so an offline-queued or
-- late-projected report cannot overwrite a newer status. NULL means no ordering
-- claim yet. Metadata-only (nullable, no default, no backfill).
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "status_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "reported_status_at" timestamp with time zone;
