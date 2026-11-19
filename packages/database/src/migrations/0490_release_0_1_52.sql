-- v0.1.52 release migration. Idempotent: every statement can run again.
--
-- Fleet users and fleet RFID cards (data passes first, before the ALTER TABLE
-- statements of this file). The Fleet Manager role: a user of it reaches only
-- the fleets assigned to it. Inserted once by id and name, never rewritten.
INSERT INTO "roles" ("id", "name", "description")
SELECT 'rol_000000000004', 'fleet_manager', 'Fleet access'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'fleet_manager')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Fleet users manage their own API keys: settings.apiKeys read and write are
-- defaults of the Fleet Manager role. Granted once to the users of that role:
-- while none of them holds settings.apiKeys:read yet, so a rerun never grants
-- back a permission an admin removed.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "user_permissions" up
    JOIN "users" u ON u."id" = up."user_id"
    JOIN "roles" r ON r."id" = u."role_id" AND r."name" = 'fleet_manager'
    WHERE up."permission" = 'settings.apiKeys:read'
  ) THEN
    INSERT INTO "user_permissions" ("user_id", "permission")
    SELECT u."id", p."permission"
    FROM "users" u
    JOIN "roles" r ON r."id" = u."role_id" AND r."name" = 'fleet_manager'
    CROSS JOIN (VALUES ('settings.apiKeys:read'), ('settings.apiKeys:write')) AS p("permission")
    ON CONFLICT ("user_id", "permission") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
-- The fleetCards permissions are role defaults of operators (read and write)
-- and viewers (read). Granted once: while no user holds fleetCards:read yet.
-- The admin grant below and sync-admin-permissions.ts give them to admins, so
-- a rerun skips this block and never grants back a permission an admin removed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "user_permissions" WHERE "permission" = 'fleetCards:read') THEN
    INSERT INTO "user_permissions" ("user_id", "permission")
    SELECT u."id", p."permission"
    FROM "users" u
    JOIN "roles" r ON r."id" = u."role_id"
    JOIN (VALUES
      ('operator', 'fleetCards:read'),
      ('operator', 'fleetCards:write'),
      ('viewer', 'fleetCards:read')
    ) AS p("role", "permission") ON p."role" = r."name"
    ON CONFLICT ("user_id", "permission") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
-- Admins hold every catalog permission (sync-admin-permissions.ts grants them
-- after each migrate too; this keeps the grant for an install that runs the
-- SQL alone).
INSERT INTO "user_permissions" ("user_id", "permission")
SELECT u."id", p."permission"
FROM "users" u
JOIN "roles" r ON r."id" = u."role_id" AND r."name" = 'admin'
CROSS JOIN (VALUES ('fleetCards:read'), ('fleetCards:write')) AS p("permission")
ON CONFLICT ("user_id", "permission") DO NOTHING;
--> statement-breakpoint
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
--> statement-breakpoint
-- When a unit's name, the one field partners see, last changed (beta.5): an
-- admin-only change (serial number, IP address, order) leaves it alone, so
-- the OCPI EVSE last_updated moves only with the name. Existing rows start at
-- their updated_at, once, when the column is added.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'station_units' AND column_name = 'name_updated_at'
  ) THEN
    ALTER TABLE "station_units" ADD COLUMN "name_updated_at" timestamp with time zone NOT NULL DEFAULT now();
    UPDATE "station_units" SET "name_updated_at" = "updated_at";
  END IF;
END $$;
--> statement-breakpoint
-- AC and DC tariffs and site availability (beta.5, GitHub discussion 64,
-- owner decisions 2026-11-13). Every existing tariff becomes Both at All
-- Sites, so its pricing is unchanged. A Selected Sites tariff lists its sites
-- in tariff_sites (a deleted site leaves the list; a tariff with no site left
-- stays Selected and matches nowhere).
ALTER TABLE "tariffs" ADD COLUMN IF NOT EXISTS "charging_type" varchar(4) NOT NULL DEFAULT 'both';
--> statement-breakpoint
ALTER TABLE "tariffs" DROP CONSTRAINT IF EXISTS "tariffs_charging_type_check";
--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_charging_type_check"
  CHECK ("charging_type" IN ('ac', 'dc', 'both'));
--> statement-breakpoint
ALTER TABLE "tariffs" ADD COLUMN IF NOT EXISTS "site_scope" varchar(8) NOT NULL DEFAULT 'all';
--> statement-breakpoint
ALTER TABLE "tariffs" DROP CONSTRAINT IF EXISTS "tariffs_site_scope_check";
--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_site_scope_check"
  CHECK ("site_scope" IN ('all', 'selected'));
--> statement-breakpoint
-- The default of a group is always Both at All Sites.
ALTER TABLE "tariffs" DROP CONSTRAINT IF EXISTS "tariffs_default_unscoped_check";
--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_default_unscoped_check"
  CHECK (NOT "is_default" OR ("charging_type" = 'both' AND "site_scope" = 'all'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tariff_sites" (
  "tariff_id" text NOT NULL REFERENCES "tariffs"("id") ON DELETE CASCADE,
  "site_id" text NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tariff_id", "site_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tariff_sites_site_id" ON "tariff_sites" ("site_id");
--> statement-breakpoint
-- The charging kind a session is priced for (ac, dc; null: not known, a
-- mixed EVSE with no connector named, or a session from before beta.5).
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "charging_kind" varchar(2);
--> statement-breakpoint
-- Added NOT VALID (no table scan under this file's ACCESS EXCLUSIVE lock) and
-- only when missing, so a rerun keeps a constraint that is already validated.
-- 0491_release_0_1_52_validate.sql validates it outside a transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_charging_kind_check'
      AND conrelid = 'charging_sessions'::regclass
  ) THEN
    ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_charging_kind_check"
      CHECK ("charging_kind" IS NULL OR "charging_kind" IN ('ac', 'dc')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- Every invoice is written with the currency it was issued in; the 'USD'
-- default left from the first schema is dropped (one company currency).
ALTER TABLE "invoices" ALTER COLUMN "currency" DROP DEFAULT;
--> statement-breakpoint
-- Uses Station Units (owner decision 2026-11-17): a station shows and takes
-- units only while it is on. Off on every station, then on for every station
-- that already has a unit, so nothing an operator set up disappears. A rerun
-- finds no station with a unit and the switch off (the API refuses that).
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "uses_units" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "charging_stations" SET "uses_units" = true
WHERE NOT "uses_units"
  AND EXISTS (SELECT 1 FROM "station_units" WHERE "station_units"."station_id" = "charging_stations"."id");
--> statement-breakpoint
-- The model and position of a unit (owner decision 2026-11-17, discussion 59),
-- null on every existing row. The model is admin metadata (at most 20
-- characters, the OCPP 1.6 chargePointModel length); the position (decimal
-- degrees, both or neither) replaces the station position for the unit's
-- EVSEs in the portal, the app and OCPI.
ALTER TABLE "station_units" ADD COLUMN IF NOT EXISTS "model" varchar(20);
--> statement-breakpoint
ALTER TABLE "station_units" ADD COLUMN IF NOT EXISTS "latitude" varchar(20);
--> statement-breakpoint
ALTER TABLE "station_units" ADD COLUMN IF NOT EXISTS "longitude" varchar(20);
--> statement-breakpoint
ALTER TABLE "station_units" ADD COLUMN IF NOT EXISTS "position_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "station_units" DROP CONSTRAINT IF EXISTS "station_units_position_check";
--> statement-breakpoint
ALTER TABLE "station_units" ADD CONSTRAINT "station_units_position_check"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
--> statement-breakpoint
-- Enable Station Units (owner decision 2026-11-17): the system-wide switch.
-- Off for a new install; on where a station already uses units or a unit
-- exists, so an install that set up units keeps them. A rerun keeps any
-- stored value (turning it off is refused while stations use units).
INSERT INTO "settings" ("key", "value")
SELECT 'stationUnits.enabled',
  to_jsonb(
    EXISTS (SELECT 1 FROM "charging_stations" WHERE "uses_units")
    OR EXISTS (SELECT 1 FROM "station_units")
  )
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
UPDATE "settings" SET "value" = 'true'::jsonb, "updated_at" = now()
WHERE "key" = 'stationUnits.enabled'
  AND "value" IS DISTINCT FROM 'true'::jsonb
  AND (
    EXISTS (SELECT 1 FROM "charging_stations" WHERE "uses_units")
    OR EXISTS (SELECT 1 FROM "station_units")
  );
--> statement-breakpoint
-- Model and serial number the station reports (owner decision 2026-11-17,
-- discussion 59): once a BootNotification reported the model, and the serial
-- number, the CSMS keeps them read-only. Null on every row, then set once
-- from the newest stored boot messages (rows still null only, so a rerun
-- changes nothing); a station whose boot messages were pruned stays editable.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "model_reported_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "serial_number_reported_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "charging_stations" cs
SET "model_reported_at" = COALESCE(cs."model_reported_at", b."booted_at"),
    "serial_number_reported_at" = COALESCE(cs."serial_number_reported_at", b."serial_at")
FROM (
  SELECT "station_id",
    max("created_at") AS "booted_at",
    max("created_at") FILTER (
      WHERE NULLIF(btrim(COALESCE(
        "payload"->>'chargePointSerialNumber',
        "payload"#>>'{chargingStation,serialNumber}'
      )), '') IS NOT NULL
    ) AS "serial_at"
  FROM "ocpp_message_logs"
  WHERE "action" = 'BootNotification' AND "direction" = 'inbound' AND "message_type" = 2
  GROUP BY "station_id"
) b
WHERE b."station_id" = cs."id"
  AND (cs."model_reported_at" IS NULL OR (cs."serial_number_reported_at" IS NULL AND b."serial_at" IS NOT NULL));
--> statement-breakpoint
-- Fleet users: access_scope 'fleets' reaches only the fleets of
-- user_fleet_assignments, never a site. Every existing user stays 'sites'.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "access_scope" varchar(10) DEFAULT 'sites' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_access_scope_check";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_access_scope_check"
  CHECK ("access_scope" IN ('sites', 'fleets'));
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_fleet_scope_check";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_fleet_scope_check"
  CHECK ("access_scope" <> 'fleets' OR NOT "has_all_site_access");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_fleet_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "fleet_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_fleet_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "user_fleet_assignments_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_fleet_assignments_user_id" ON "user_fleet_assignments" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_fleet_assignments_fleet_id" ON "user_fleet_assignments" ("fleet_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_fleet_assignments_unique" ON "user_fleet_assignments" ("user_id", "fleet_id");
--> statement-breakpoint
-- Fleet RFID cards: the fleet that owns a card, null on every existing card.
-- A fleet that still owns cards cannot be deleted (RESTRICT).
ALTER TABLE "driver_tokens" ADD COLUMN IF NOT EXISTS "fleet_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_fleet_id_fleets_id_fk"
    FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_driver_tokens_fleet_id" ON "driver_tokens" ("fleet_id") WHERE "fleet_id" IS NOT NULL;
--> statement-breakpoint
-- A fleet user can deactivate a fleet card: deactivated_by 'fleet'.
ALTER TABLE "driver_tokens" DROP CONSTRAINT IF EXISTS "driver_tokens_deactivated_by_check";
--> statement-breakpoint
ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_deactivated_by_check"
  CHECK ("deactivated_by" IS NULL OR "deactivated_by" IN ('operator', 'driver', 'system', 'fleet'));
--> statement-breakpoint
-- Fleet manager notices: the claim that tells a fleet's fleet users of a new
-- fleet invoice once (null on every existing invoice: none is sent for them).
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fleet_managers_notified_at" timestamp with time zone;
--> statement-breakpoint
-- Fleet RFID card notices to the member a card is given to or taken back from (on by default).
INSERT INTO driver_event_settings (event_type, is_enabled) VALUES
  ('token.FleetCardAssigned', true),
  ('token.FleetCardTakenBack', true)
ON CONFLICT (event_type) DO NOTHING;
--> statement-breakpoint
-- Monthly spending limit of a fleet RFID card, in cents of the company
-- currency (null on every existing card: no limit).
ALTER TABLE "driver_tokens" ADD COLUMN IF NOT EXISTS "monthly_limit_cents" integer;
--> statement-breakpoint
ALTER TABLE "driver_tokens" DROP CONSTRAINT IF EXISTS "driver_tokens_monthly_limit_check";
--> statement-breakpoint
ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_monthly_limit_check"
  CHECK ("monthly_limit_cents" IS NULL OR "monthly_limit_cents" > 0);
--> statement-breakpoint
-- The station screen of a session a fleet RFID card's monthly limit stopped,
-- in the six display languages. ON CONFLICT DO NOTHING keeps operator edits.
INSERT INTO "station_message_templates" ("state", "language", "body") VALUES
  ('card_monthly_limit', 'en', E'Monthly limit of this card reached.\nCharging stopped.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('card_monthly_limit', 'de', E'Monatslimit dieser Karte erreicht.\nLaden beendet.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('card_monthly_limit', 'es', E'Límite mensual de esta tarjeta alcanzado.\nCarga detenida.\n{{#if supportPhone}}Soporte: {{supportPhone}}{{/if}}'),
  ('card_monthly_limit', 'ko', E'이 카드의 월 한도에 도달했습니다.\n충전이 중지되었습니다.\n{{#if supportPhone}}고객센터: {{supportPhone}}{{/if}}'),
  ('card_monthly_limit', 'zh', E'此卡已达到每月限额。\n充电已停止。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}'),
  ('card_monthly_limit', 'zh-TW', E'此卡已達每月限額。\n充電已停止。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The claim that sends the member holding a fleet RFID card the notice of its
-- monthly spending limit once per card, month (system timezone) and limit.
CREATE TABLE IF NOT EXISTS "card_monthly_limit_notices" (
  "token_id" text NOT NULL,
  "period_start" date NOT NULL,
  "limit_cents" integer NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "card_monthly_limit_notices_pkey" PRIMARY KEY ("token_id", "period_start", "limit_cents")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "card_monthly_limit_notices" ADD CONSTRAINT "card_monthly_limit_notices_token_id_driver_tokens_id_fk"
    FOREIGN KEY ("token_id") REFERENCES "driver_tokens"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- The driver notice of a fleet RFID card that reached its monthly spending limit (on by default).
INSERT INTO driver_event_settings (event_type, is_enabled) VALUES
  ('token.MonthlyLimitReached', true)
ON CONFLICT (event_type) DO NOTHING;
--> statement-breakpoint
-- Fleets access belongs to the Fleet Manager role and that role to Fleets
-- access. Earlier builds of this release saved mixes: a fleet user with
-- another role gets the Fleet Manager role, a site user with the Fleet
-- Manager role gets the Operator role. Stored permissions do not change
-- (they decide access, the role only names the defaults). A rerun finds no
-- mix and writes nothing.
DO $$
DECLARE
  fm_role text;
  site_role text;
  to_fm integer := 0;
  to_site integer := 0;
BEGIN
  SELECT id INTO fm_role FROM roles WHERE name = 'fleet_manager' LIMIT 1;
  SELECT id INTO site_role FROM roles WHERE name = 'operator' LIMIT 1;
  IF fm_role IS NOT NULL THEN
    WITH moved AS (
      UPDATE users u SET role_id = fm_role, updated_at = now()
      FROM roles r
      WHERE r.id = u.role_id AND u.access_scope = 'fleets' AND r.name <> 'fleet_manager'
      RETURNING u.id, r.id AS old_role
    ), audited AS (
      INSERT INTO user_audit_log (user_id, user_id_snapshot, action, actor, before, after, notes)
      SELECT id, id, 'role_changed', 'system',
        jsonb_build_object('roleId', old_role, 'accessScope', 'fleets'),
        jsonb_build_object('roleId', fm_role, 'accessScope', 'fleets'),
        'Fleets access needs the Fleet Manager role'
      FROM moved
      RETURNING 1
    )
    SELECT count(*) INTO to_fm FROM audited;
    IF site_role IS NOT NULL THEN
      WITH moved AS (
        UPDATE users u SET role_id = site_role, updated_at = now()
        WHERE u.role_id = fm_role AND u.access_scope = 'sites'
        RETURNING u.id
      ), audited AS (
        INSERT INTO user_audit_log (user_id, user_id_snapshot, action, actor, before, after, notes)
        SELECT id, id, 'role_changed', 'system',
          jsonb_build_object('roleId', fm_role, 'accessScope', 'sites'),
          jsonb_build_object('roleId', site_role, 'accessScope', 'sites'),
          'The Fleet Manager role needs Fleets access'
        FROM moved
        RETURNING 1
      )
      SELECT count(*) INTO to_site FROM audited;
    END IF;
  END IF;
  IF to_fm > 0 OR to_site > 0 THEN
    RAISE NOTICE 'Fleet Manager role and Fleets access: % fleet users moved to the Fleet Manager role, % site users moved to the Operator role', to_fm, to_site;
  END IF;
END $$;
--> statement-breakpoint
-- The fleetBilling permissions (a fleet user edits its fleet's billing
-- profile): admins hold every catalog permission (sync-admin-permissions.ts
-- grants them after each migrate too). No other role gets them by default:
-- an operator grants fleetBilling:write to a fleet manager on purpose.
INSERT INTO "user_permissions" ("user_id", "permission")
SELECT u."id", p."permission"
FROM "users" u
JOIN "roles" r ON r."id" = u."role_id" AND r."name" = 'admin'
CROSS JOIN (VALUES ('fleetBilling:read'), ('fleetBilling:write')) AS p("permission")
ON CONFLICT ("user_id", "permission") DO NOTHING;
--> statement-breakpoint
-- Card ids match regardless of letter case from v0.1.52 (GitHub issue 70).
-- Cards already stored as case-only pairs (the same value in another letter
-- case, vehicle id cards left out) are kept, not merged or deleted: a station value that matches
-- one of them exactly picks it, one that matches none exactly is refused. The
-- count tells the operator how many such groups exist.
DO $$
DECLARE pairs integer;
BEGIN
  SELECT count(*) INTO pairs FROM (
    SELECT lower(id_token) FROM driver_tokens
    WHERE token_type NOT IN ('VIN', 'EVCCID', 'MacAddress')
    GROUP BY lower(id_token)
    HAVING count(DISTINCT id_token) > 1
  ) g;
  IF pairs > 0 THEN
    RAISE NOTICE 'RFID cards that differ only in letter case: % groups kept; a station value that matches none of a group exactly is refused', pairs;
  END IF;
END $$;
