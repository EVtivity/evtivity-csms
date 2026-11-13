-- v0.1.52 release migration. Idempotent: every statement can run again.
--
-- Station units: an operator groups the EVSEs of one OCPP station into named
-- physical units (a master box and its extenders). No existing row changes: an
-- EVSE starts with no unit (unit_id null), so a station without units stays as
-- it is. The new audit value is used by no statement of this file.
ALTER TYPE "station_audit_action" ADD VALUE IF NOT EXISTS 'unit_changed';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "station_units" (
  "id" text PRIMARY KEY NOT NULL,
  "station_id" text NOT NULL REFERENCES "charging_stations"("id") ON DELETE CASCADE,
  "name" varchar(50) NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "uq_station_units_id_station" UNIQUE ("id", "station_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_units_station_id" ON "station_units" ("station_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_station_units_station_name" ON "station_units" ("station_id", lower("name"));
--> statement-breakpoint
-- A null unit_id is not checked (MATCH SIMPLE), so every existing EVSE stays
-- valid; a unit id must name a unit of the EVSE's own station.
ALTER TABLE "evses" ADD COLUMN IF NOT EXISTS "unit_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "evses" ADD CONSTRAINT "fk_evses_unit_same_station"
    FOREIGN KEY ("unit_id", "station_id") REFERENCES "station_units"("id", "station_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_evses_unit_id" ON "evses" ("unit_id") WHERE "unit_id" IS NOT NULL;
--> statement-breakpoint
-- The 2D board card of a unit of a station with units, in board px. Written
-- only by the layout writer; gone with its unit or site.
CREATE TABLE IF NOT EXISTS "station_unit_board_positions" (
  "unit_id" text PRIMARY KEY NOT NULL REFERENCES "station_units"("id") ON DELETE CASCADE,
  "site_id" text NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "board_x" integer NOT NULL,
  "board_y" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_unit_board_positions_site" ON "station_unit_board_positions" ("site_id");
--> statement-breakpoint
-- Favorites and watches per unit: a nullable unit_id (null is the whole
-- station, every existing row), kept on the row's own station and deleted
-- with its unit. One row per driver, station and unit (nulls equal).
ALTER TABLE "driver_favorite_stations" ADD COLUMN IF NOT EXISTS "unit_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "driver_favorite_stations" ADD CONSTRAINT "fk_driver_favorite_stations_unit"
    FOREIGN KEY ("unit_id", "station_id") REFERENCES "station_units"("id", "station_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_driver_favorite_stations_unit" ON "driver_favorite_stations" ("driver_id", "station_id", "unit_id") NULLS NOT DISTINCT;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_driver_favorite_stations_unique";
--> statement-breakpoint
ALTER TABLE "station_watches" ADD COLUMN IF NOT EXISTS "unit_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "station_watches" ADD CONSTRAINT "fk_station_watches_unit"
    FOREIGN KEY ("unit_id", "station_id") REFERENCES "station_units"("id", "station_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_station_watches_unit" ON "station_watches" ("driver_id", "station_id", "unit_id") NULLS NOT DISTINCT;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_station_watches_unique";
--> statement-breakpoint
-- A driver can close the own support case (resolved, resolution source
-- driver). The CHECK is replaced whole, so a rerun ends with the same one.
ALTER TABLE "support_cases" DROP CONSTRAINT IF EXISTS "support_cases_resolution_source_check";
--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_resolution_source_check"
  CHECK ("resolution_source" IN ('operator', 'ai', 'driver'));
--> statement-breakpoint
-- Optional admin metadata of a unit (beta.4): its serial number and IP
-- address, null on every existing row. The API checks and canonicalizes both.
ALTER TABLE "station_units" ADD COLUMN IF NOT EXISTS "serial_number" text;
--> statement-breakpoint
ALTER TABLE "station_units" ADD COLUMN IF NOT EXISTS "ip_address" text;
