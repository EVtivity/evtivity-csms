-- Station availability becomes a computed result. Its inputs are stored
-- separately: an operator or security disable, the firmware install state, the
-- station's own reported status, and the connector statuses.
DO $$ BEGIN
  CREATE TYPE "public"."station_disabled_reason" AS ENUM('operator', 'security');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."station_firmware_state" AS ENUM('installing', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "disabled_reason" "station_disabled_reason";
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "firmware_state" "station_firmware_state";
--> statement-breakpoint
-- Firmware state from the latest firmware update of stations that are
-- unavailable (installing) or faulted (failed install).
UPDATE "charging_stations" cs
SET "firmware_state" = (CASE
    WHEN fu."status" = 'Installing' THEN 'installing'
    ELSE 'failed'
  END)::"station_firmware_state"
FROM (
  SELECT DISTINCT ON ("station_id") "station_id", "status"
  FROM "firmware_updates"
  ORDER BY "station_id", COALESCE("last_status_at", "updated_at") DESC
) fu
WHERE fu."station_id" = cs."id"
  AND cs."firmware_state" IS NULL
  AND (
    (cs."availability" = 'unavailable' AND fu."status" = 'Installing')
    OR (cs."availability" = 'faulted'
      AND fu."status" IN ('InstallationFailed', 'InvalidSignature', 'InstallVerificationFailed'))
  );
--> statement-breakpoint
-- Any other unavailable station was switched off: by the critical-security
-- auto-disable when its latest availability audit row says so, else by an
-- operator.
UPDATE "charging_stations" cs
SET "disabled_reason" = (CASE
    WHEN (
      SELECT a."actor_label" FROM "station_audit_log" a
      WHERE a."station_id" = cs."id" AND a."after" ->> 'availability' = 'unavailable'
      ORDER BY a."created_at" DESC
      LIMIT 1
    ) LIKE 'security-critical:%' THEN 'security'
    ELSE 'operator'
  END)::"station_disabled_reason"
WHERE cs."availability" = 'unavailable'
  AND cs."disabled_reason" IS NULL
  AND cs."firmware_state" IS NULL;
--> statement-breakpoint
-- Recompute availability from the inputs (same rule as station-status.ts).
UPDATE "charging_stations" cs
SET "availability" = (CASE
    WHEN cs."disabled_reason" IS NOT NULL THEN 'unavailable'
    WHEN cs."firmware_state" = 'failed'
      OR cs."reported_status" = 'faulted'
      OR EXISTS (
        SELECT 1 FROM "connectors" c JOIN "evses" e ON e."id" = c."evse_id"
        WHERE e."station_id" = cs."id" AND c."status" = 'faulted'
      ) THEN 'faulted'
    WHEN cs."firmware_state" = 'installing' OR cs."reported_status" = 'unavailable' THEN 'unavailable'
    ELSE 'available'
  END)::"charging_station_status";
