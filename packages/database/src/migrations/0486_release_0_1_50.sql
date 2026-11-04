-- v0.1.50 release migration. Idempotent: every statement can run again.
--
-- Route-aware charging: departures and weekly departure schedules of fleet
-- vehicles, the notices sent for them, the current charging plan of each site,
-- the vehicle battery fields, the card to vehicle link, the site finish buffer
-- and the departure_aware allocation strategy. No statement of this file uses
-- the enum value it adds (one file is one transaction). The CHECKs and foreign
-- keys written inside CREATE TABLE IF NOT EXISTS do not change on a database
-- that has the table: a later change to one needs its own drop and add.
ALTER TYPE "load_allocation_strategy" ADD VALUE IF NOT EXISTS 'departure_aware';
--> statement-breakpoint
-- Usable battery size (needed for state of charge targets) and the power the
-- vehicle accepts (null: the charger maximum).
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "battery_capacity_kwh" numeric(7, 2);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "max_charge_power_kw" numeric(7, 2);
--> statement-breakpoint
ALTER TABLE "vehicles" DROP CONSTRAINT IF EXISTS "vehicles_battery_capacity_check";
--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_battery_capacity_check"
  CHECK ("battery_capacity_kwh" IS NULL OR "battery_capacity_kwh" BETWEEN 1 AND 2000);
--> statement-breakpoint
ALTER TABLE "vehicles" DROP CONSTRAINT IF EXISTS "vehicles_max_charge_power_check";
--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_max_charge_power_check"
  CHECK ("max_charge_power_kw" IS NULL OR "max_charge_power_kw" BETWEEN 1 AND 3750);
--> statement-breakpoint
-- A card that belongs to one vehicle of its driver.
ALTER TABLE "driver_tokens" ADD COLUMN IF NOT EXISTS "vehicle_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_vehicle_id_vehicles_id_fk"
    FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_driver_tokens_vehicle_id" ON "driver_tokens" USING btree ("vehicle_id");
--> statement-breakpoint
-- An operator assigned the session's vehicle by hand: a driver cannot replace
-- or clear it while the depot plan charges the session. A constant default
-- adds the column without rewriting the table.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "vehicle_assigned_by_operator" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Weekly repeating departures. Days are ISO (1 Monday to 7 Sunday), the time is
-- HH:MM in the site's time zone, the target is energy or state of charge.
CREATE TABLE IF NOT EXISTS "vehicle_departure_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "vehicle_id" text NOT NULL,
  "site_id" text NOT NULL,
  "days_of_week" smallint[] NOT NULL,
  "departure_time" varchar(5) NOT NULL,
  "target_kind" varchar(10) NOT NULL,
  "target_energy_kwh" numeric(7, 2),
  "target_soc_percent" smallint,
  "priority" smallint DEFAULT 5 NOT NULL,
  "valid_from" date,
  "valid_to" date,
  "is_active" boolean DEFAULT true NOT NULL,
  "notes" varchar(500),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vehicle_departure_schedules_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "vehicle_departure_schedules_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "vds_target_check" CHECK (("target_kind" = 'energy' AND "target_energy_kwh" IS NOT NULL AND "target_soc_percent" IS NULL)
    OR ("target_kind" = 'soc' AND "target_soc_percent" IS NOT NULL AND "target_energy_kwh" IS NULL)),
  CONSTRAINT "vds_target_range_check" CHECK (("target_energy_kwh" IS NULL OR "target_energy_kwh" BETWEEN 0.1 AND 2000)
    AND ("target_soc_percent" IS NULL OR "target_soc_percent" BETWEEN 1 AND 100)),
  CONSTRAINT "vds_days_check" CHECK (cardinality("days_of_week") > 0 AND "days_of_week" <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CONSTRAINT "vds_time_check" CHECK ("departure_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "vds_priority_check" CHECK ("priority" BETWEEN 1 AND 10),
  CONSTRAINT "vds_valid_range_check" CHECK ("valid_from" IS NULL OR "valid_to" IS NULL OR "valid_from" <= "valid_to")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departure_schedules_vehicle" ON "vehicle_departure_schedules" USING btree ("vehicle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departure_schedules_site" ON "vehicle_departure_schedules" USING btree ("site_id");
--> statement-breakpoint
-- Every departure, one-off or a schedule occurrence. Cancelled and completed
-- are terminal; the readiness columns are the planner's output.
CREATE TABLE IF NOT EXISTS "vehicle_departures" (
  "id" text PRIMARY KEY NOT NULL,
  "vehicle_id" text NOT NULL,
  "site_id" text NOT NULL,
  "schedule_id" text,
  "occurrence_date" date,
  "departure_at" timestamp with time zone NOT NULL,
  "target_kind" varchar(10) NOT NULL,
  "target_energy_kwh" numeric(7, 2),
  "target_soc_percent" smallint,
  "priority" smallint DEFAULT 5 NOT NULL,
  "source" varchar(12) NOT NULL,
  "overridden" boolean DEFAULT false NOT NULL,
  "status" varchar(10) DEFAULT 'scheduled' NOT NULL,
  "outcome" varchar(12),
  "readiness" varchar(20),
  "session_id" text,
  "planned_kwh" numeric(8, 2),
  "delivered_kwh" numeric(8, 2),
  "shortfall_kwh" numeric(8, 2),
  "predicted_ready_at" timestamp with time zone,
  "readiness_reason" varchar(30),
  "planned_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vehicle_departures_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "vehicle_departures_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "vehicle_departures_schedule_id_vehicle_departure_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."vehicle_departure_schedules"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "vehicle_departures_session_id_charging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "vdp_target_check" CHECK (("target_kind" = 'energy' AND "target_energy_kwh" IS NOT NULL AND "target_soc_percent" IS NULL)
    OR ("target_kind" = 'soc' AND "target_soc_percent" IS NOT NULL AND "target_energy_kwh" IS NULL)),
  CONSTRAINT "vdp_target_range_check" CHECK (("target_energy_kwh" IS NULL OR "target_energy_kwh" BETWEEN 0.1 AND 2000)
    AND ("target_soc_percent" IS NULL OR "target_soc_percent" BETWEEN 1 AND 100)),
  CONSTRAINT "vdp_priority_check" CHECK ("priority" BETWEEN 1 AND 10),
  CONSTRAINT "vdp_source_check" CHECK ("source" IN ('manual', 'schedule', 'import', 'vehicle', 'provider')),
  CONSTRAINT "vdp_status_check" CHECK ("status" IN ('scheduled', 'cancelled', 'completed')),
  CONSTRAINT "vdp_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('met', 'short', 'no_vehicle')),
  CONSTRAINT "vdp_readiness_check" CHECK ("readiness" IS NULL OR "readiness" IN ('ready', 'on_track', 'at_risk', 'cannot_meet', 'waiting_for_vehicle')),
  CONSTRAINT "vdp_readiness_reason_check" CHECK ("readiness_reason" IS NULL OR "readiness_reason" IN ('site_capacity', 'not_plugged_in', 'late_arrival', 'charger_not_following', 'profile_rejected', 'station_offline', 'vehicle_power', 'unknown_soc')),
  CONSTRAINT "vdp_completed_outcome_check" CHECK (("status" = 'completed') = ("outcome" IS NOT NULL))
);
--> statement-breakpoint
-- One row per schedule occurrence, so the expand cron can run twice.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vehicle_departures_occurrence" ON "vehicle_departures" USING btree ("schedule_id", "occurrence_date") WHERE "schedule_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departures_site_scheduled" ON "vehicle_departures" USING btree ("site_id", "departure_at") WHERE "status" = 'scheduled';
--> statement-breakpoint
-- The departure-close cron reads scheduled departures across every site by time.
CREATE INDEX IF NOT EXISTS "idx_vehicle_departures_scheduled_due" ON "vehicle_departures" USING btree ("departure_at", "id") WHERE "status" = 'scheduled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departures_vehicle" ON "vehicle_departures" USING btree ("vehicle_id", "departure_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departures_session" ON "vehicle_departures" USING btree ("session_id");
--> statement-breakpoint
-- The at-risk and missed notices sent for a departure, once per kind.
CREATE TABLE IF NOT EXISTS "vehicle_departure_notices" (
  "departure_id" text NOT NULL,
  "kind" varchar(12) NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vehicle_departure_notices_departure_id_kind_pk" PRIMARY KEY ("departure_id", "kind"),
  CONSTRAINT "vehicle_departure_notices_departure_id_vehicle_departures_id_fk" FOREIGN KEY ("departure_id") REFERENCES "public"."vehicle_departures"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "vehicle_departure_notices_kind_check" CHECK ("kind" IN ('at_risk', 'missed'))
);
--> statement-breakpoint
-- The current charging plan of a site, one row per site, overwritten by each plan.
CREATE TABLE IF NOT EXISTS "site_charging_plans" (
  "site_id" text PRIMARY KEY NOT NULL,
  "computed_at" timestamp with time zone NOT NULL,
  "stale_at" timestamp with time zone,
  "trigger" varchar(30),
  "slot_starts" jsonb,
  "plan" jsonb,
  "site_load_kw" jsonb,
  "capacity_kw" jsonb,
  "price_per_kwh" jsonb,
  "runtime_ms" integer,
  CONSTRAINT "site_charging_plans_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- How long before a departure the planner aims to finish, 0 to 180 minutes.
ALTER TABLE "site_load_management" ADD COLUMN IF NOT EXISTS "departure_buffer_minutes" smallint DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "site_load_management" DROP CONSTRAINT IF EXISTS "site_load_management_departure_buffer_check";
--> statement-breakpoint
ALTER TABLE "site_load_management" ADD CONSTRAINT "site_load_management_departure_buffer_check"
  CHECK ("departure_buffer_minutes" BETWEEN 0 AND 180);
--> statement-breakpoint
-- New audited entity: vehicle departures and departure schedules.
DO $$ BEGIN
  CREATE TYPE "vehicle_departure_audit_action" AS ENUM ('schedule_created', 'schedule_updated', 'schedule_deleted', 'departure_created', 'departure_updated', 'departure_cancelled', 'departures_imported');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicle_departure_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "vehicle_departure_id" text,
  "vehicle_departure_id_snapshot" text NOT NULL,
  "action" "vehicle_departure_audit_action" NOT NULL,
  "actor" "audit_actor" NOT NULL,
  "actor_user_id" text,
  "actor_driver_id" text,
  "actor_api_key_id" text,
  "actor_label" varchar(100),
  "before" jsonb,
  "after" jsonb,
  "notes" text,
  "via_ai" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departure_audit_entity_id" ON "vehicle_departure_audit_log" ("vehicle_departure_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departure_audit_created_at" ON "vehicle_departure_audit_log" ("created_at");
--> statement-breakpoint
-- Fleet charging is off until an operator turns it on; departures are kept
-- 365 days. ON CONFLICT DO NOTHING keeps an operator's value.
INSERT INTO "settings" ("key", "value") VALUES
  ('fleetCharging.enabled', 'false'::jsonb),
  ('logs.departures.retentionDays', '365'::jsonb)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Departure crons: schedule occurrences turned into departures every 15
-- minutes, and departures past their time completed every minute.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'departure-schedule-expand', '*/15 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'departure-schedule-expand');
--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'departure-close', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'departure-close');
--> statement-breakpoint
-- VDV 463, the bus depot interface (features/vdv-463.md): depot systems, the
-- charging request fields of a departure, preconditioning, the 2.1
-- preconditioning status of a session. Every statement is idempotent: the
-- block reruns on databases that ran an earlier build of this file.
CREATE TABLE IF NOT EXISTS "depot_systems" (
  "id" text PRIMARY KEY NOT NULL,
  "presystem_id" varchar(255) NOT NULL,
  "name" varchar(100) NOT NULL,
  "system_type" varchar(4) NOT NULL,
  "password_hash" text NOT NULL,
  "is_enabled" boolean DEFAULT false NOT NULL,
  "info_interval_seconds" smallint DEFAULT 30 NOT NULL,
  "request_timeout_seconds" smallint DEFAULT 30 NOT NULL,
  "max_retries" smallint DEFAULT 3 NOT NULL,
  "keepalive_timeout_seconds" smallint DEFAULT 180 NOT NULL,
  "failed_auth_count" smallint DEFAULT 0 NOT NULL,
  "auth_locked_until" timestamp with time zone,
  "last_connected_at" timestamp with time zone,
  "last_boot_at" timestamp with time zone,
  "last_message_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "depot_systems_type_check" CHECK ("system_type" IN ('BMS', 'ITCS')),
  CONSTRAINT "depot_systems_interval_check" CHECK ("info_interval_seconds" BETWEEN 10 AND 600),
  CONSTRAINT "depot_systems_timeout_check" CHECK ("request_timeout_seconds" BETWEEN 5 AND 120),
  CONSTRAINT "depot_systems_retries_check" CHECK ("max_retries" BETWEEN 0 AND 10),
  CONSTRAINT "depot_systems_keepalive_check" CHECK ("keepalive_timeout_seconds" BETWEEN 30 AND 900)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_depot_systems_presystem_id" ON "depot_systems" USING btree ("presystem_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "depot_system_sites" (
  "depot_system_id" text NOT NULL,
  "site_id" text NOT NULL,
  CONSTRAINT "depot_system_sites_depot_system_id_site_id_pk" PRIMARY KEY ("depot_system_id", "site_id"),
  CONSTRAINT "depot_system_sites_depot_system_id_depot_systems_id_fk" FOREIGN KEY ("depot_system_id") REFERENCES "public"."depot_systems"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "depot_system_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "depot_system_refused_requests" (
  "depot_system_id" text NOT NULL,
  "external_request_id" varchar(255) NOT NULL,
  "vehicle_ref" varchar(255),
  "reason" varchar(40) NOT NULL,
  "refused_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notified_at" timestamp with time zone,
  CONSTRAINT "depot_system_refused_requests_depot_system_id_external_request_id_pk" PRIMARY KEY ("depot_system_id", "external_request_id"),
  CONSTRAINT "depot_system_refused_requests_depot_system_id_depot_systems_id_fk" FOREIGN KEY ("depot_system_id") REFERENCES "public"."depot_systems"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "depot_system_audit_action" AS ENUM ('created', 'updated', 'deleted', 'password_rotated', 'requests_applied', 'auth_locked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TYPE "depot_system_audit_action" ADD VALUE IF NOT EXISTS 'auth_locked';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "depot_system_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "depot_system_id" text,
  "depot_system_id_snapshot" text NOT NULL,
  "action" "depot_system_audit_action" NOT NULL,
  "actor" "audit_actor" NOT NULL,
  "actor_user_id" text,
  "actor_driver_id" text,
  "actor_api_key_id" text,
  "actor_label" varchar(100),
  "before" jsonb,
  "after" jsonb,
  "notes" text,
  "via_ai" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_depot_system_audit_entity_id" ON "depot_system_audit_log" ("depot_system_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_depot_system_audit_created_at" ON "depot_system_audit_log" ("created_at");
--> statement-breakpoint
-- Charging request fields of a departure. target_soc_percent is the minimum
-- target; target_soc_max_percent the level to charge on to from spare capacity.
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "ad_hoc" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "target_soc_max_percent" smallint;
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "expected_arrival_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "expected_arrival_soc_percent" smallint;
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "requested_evse_id" text;
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "depot_system_id" text;
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "external_request_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "external_priority" integer;
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "cancel_reason" varchar(30);
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD COLUMN IF NOT EXISTS "predicted_max_ready_at" timestamp with time zone;
--> statement-breakpoint
-- An ad hoc departure has no departure time.
ALTER TABLE "vehicle_departures" ALTER COLUMN "departure_at" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vehicle_departures_requested_evse_id_evses_id_fk"
    FOREIGN KEY ("requested_evse_id") REFERENCES "public"."evses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vehicle_departures_depot_system_id_depot_systems_id_fk"
    FOREIGN KEY ("depot_system_id") REFERENCES "public"."depot_systems"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- The unshipped placeholder source 'provider' is replaced by 'depot_system'; no
-- code wrote it, so a row with it can only be test data and becomes manual.
ALTER TABLE "vehicle_departures" DROP CONSTRAINT IF EXISTS "vdp_source_check";
--> statement-breakpoint
UPDATE "vehicle_departures" SET "source" = 'manual' WHERE "source" = 'provider';
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vdp_source_check"
  CHECK ("source" IN ('manual', 'schedule', 'import', 'vehicle', 'depot_system'));
--> statement-breakpoint
ALTER TABLE "vehicle_departures" DROP CONSTRAINT IF EXISTS "vdp_target_range_check";
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vdp_target_range_check"
  CHECK (("target_energy_kwh" IS NULL OR "target_energy_kwh" BETWEEN 0.1 AND 2000)
    AND ("target_soc_percent" IS NULL OR "target_soc_percent" BETWEEN 0 AND 100));
--> statement-breakpoint
ALTER TABLE "vehicle_departures" DROP CONSTRAINT IF EXISTS "vdp_soc_max_check";
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vdp_soc_max_check"
  CHECK ("target_soc_max_percent" IS NULL OR ("target_kind" = 'soc' AND "target_soc_max_percent" BETWEEN "target_soc_percent" AND 100));
--> statement-breakpoint
ALTER TABLE "vehicle_departures" DROP CONSTRAINT IF EXISTS "vdp_ad_hoc_check";
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vdp_ad_hoc_check"
  CHECK ("ad_hoc" = ("departure_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "vehicle_departures" DROP CONSTRAINT IF EXISTS "vdp_arrival_check";
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vdp_arrival_check"
  CHECK (("expected_arrival_soc_percent" IS NULL OR "expected_arrival_soc_percent" BETWEEN 0 AND 100)
    AND ("expected_arrival_at" IS NULL OR "departure_at" IS NULL OR "expected_arrival_at" < "departure_at"));
--> statement-breakpoint
ALTER TABLE "vehicle_departures" DROP CONSTRAINT IF EXISTS "vdp_external_check";
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vdp_external_check"
  CHECK (("source" = 'depot_system') = ("external_request_id" IS NOT NULL)
    AND ("source" = 'depot_system' OR "depot_system_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "vehicle_departures" DROP CONSTRAINT IF EXISTS "vdp_cancel_reason_check";
--> statement-breakpoint
ALTER TABLE "vehicle_departures" ADD CONSTRAINT "vdp_cancel_reason_check"
  CHECK ("cancel_reason" IS NULL OR ("status" = 'cancelled'
    AND "cancel_reason" IN ('removed_by_depot_system', 'terminated_by_depot_system', 'superseded_by_depot_system')));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vehicle_departures_external" ON "vehicle_departures" USING btree ("depot_system_id", "external_request_id") WHERE "status" = 'scheduled' AND "depot_system_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicle_departures_ad_hoc" ON "vehicle_departures" USING btree ("site_id") WHERE "ad_hoc" AND "status" = 'scheduled';
--> statement-breakpoint
ALTER TABLE "vehicle_departure_schedules" ADD COLUMN IF NOT EXISTS "target_soc_max_percent" smallint;
--> statement-breakpoint
ALTER TABLE "vehicle_departure_schedules" DROP CONSTRAINT IF EXISTS "vds_soc_max_check";
--> statement-breakpoint
ALTER TABLE "vehicle_departure_schedules" ADD CONSTRAINT "vds_soc_max_check"
  CHECK ("target_soc_max_percent" IS NULL OR ("target_kind" = 'soc' AND "target_soc_max_percent" BETWEEN "target_soc_percent" AND 100));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicle_departure_preconditioning" (
  "departure_id" text PRIMARY KEY NOT NULL,
  "climate" varchar(30),
  "ambient_temperature_c" smallint,
  "start_at" timestamp with time zone,
  "finish_at" timestamp with time zone,
  "hvac_start_at" timestamp with time zone,
  "hvac_kw" numeric(6, 2),
  "system_start_at" timestamp with time zone,
  "system_kw" numeric(6, 2),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vehicle_departure_preconditioning_departure_id_vehicle_departures_id_fk" FOREIGN KEY ("departure_id") REFERENCES "public"."vehicle_departures"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "vdpc_climate_check" CHECK ("climate" IS NULL OR "climate" IN ('warm_water_ventilation', 'hot_water_heating', 'no_heating_cooling_ventilation', 'none')),
  CONSTRAINT "vdpc_temperature_check" CHECK ("ambient_temperature_c" IS NULL OR "ambient_temperature_c" BETWEEN -50 AND 70),
  CONSTRAINT "vdpc_window_check" CHECK ("start_at" IS NULL OR "finish_at" IS NULL OR "start_at" < "finish_at"),
  CONSTRAINT "vdpc_power_check" CHECK (("hvac_kw" IS NULL OR "hvac_kw" BETWEEN 0 AND 500) AND ("system_kw" IS NULL OR "system_kw" BETWEEN 0 AND 500))
);
--> statement-breakpoint
-- What a vehicle draws while it preconditions, and the length of an automatic
-- preconditioning window that names no start time.
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "preconditioning_power_kw" numeric(6, 2);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "preconditioning_minutes" smallint DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicles" DROP CONSTRAINT IF EXISTS "vehicles_preconditioning_power_check";
--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_preconditioning_power_check"
  CHECK ("preconditioning_power_kw" IS NULL OR "preconditioning_power_kw" BETWEEN 0.5 AND 500);
--> statement-breakpoint
ALTER TABLE "vehicles" DROP CONSTRAINT IF EXISTS "vehicles_preconditioning_minutes_check";
--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_preconditioning_minutes_check"
  CHECK ("preconditioning_minutes" BETWEEN 5 AND 240);
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "preconditioning_status" varchar(20);
--> statement-breakpoint
-- The bus depot interface is off until an operator turns it on.
INSERT INTO "settings" ("key", "value") VALUES ('vdv463.enabled', 'false'::jsonb)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Power equipment in load management (features/load-management.md):
-- transformers (service and step-down) as limits of the tree, batteries and
-- solar as supply, the latest reading of each asset, the transformer link of
-- a panel and the supply credit of each allocation. The transformers and
-- energy assets of sites.layout_settings move into the tables, unlinked and
-- informational, and the layout keeps only their positions. Every statement
-- is idempotent; the move runs only for entries still in the old form (with
-- a name or a rating), so a rerun finds nothing to move.
DO $$ BEGIN
  CREATE TYPE "transformer_kind" AS ENUM ('service', 'step_down');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "energy_asset_type" AS ENUM ('battery', 'solar');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "energy_asset_grid_charging" AS ENUM ('never', 'possible');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "energy_asset_telemetry" AS ENUM ('none', 'api', 'simulated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transformers" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "kind" "transformer_kind" NOT NULL,
  "name" varchar(60) NOT NULL,
  "rated_kva" numeric,
  "phases" integer DEFAULT 3 NOT NULL,
  "secondary_voltage_v" integer,
  "power_factor" numeric(3, 2) DEFAULT '0.95' NOT NULL,
  "loading_limit_percent" integer DEFAULT 100 NOT NULL,
  "safety_margin_kw" numeric DEFAULT '0' NOT NULL,
  "fed_from_panel_id" text,
  "max_continuous_kw" numeric,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "transformers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "transformers_fed_from_panel_id_panels_id_fk" FOREIGN KEY ("fed_from_panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "transformers_kind_feed_check" CHECK (("kind" = 'service') = ("fed_from_panel_id" IS NULL)),
  CONSTRAINT "transformers_rated_kva_check" CHECK ("rated_kva" IS NULL OR "rated_kva" BETWEEN 1 AND 100000),
  CONSTRAINT "transformers_phases_check" CHECK ("phases" IN (1, 3)),
  CONSTRAINT "transformers_secondary_voltage_check" CHECK ("secondary_voltage_v" IS NULL OR "secondary_voltage_v" IN (120, 208, 220, 230, 240, 277, 480)),
  CONSTRAINT "transformers_power_factor_check" CHECK ("power_factor" BETWEEN 0.80 AND 1.00),
  CONSTRAINT "transformers_loading_limit_check" CHECK ("loading_limit_percent" BETWEEN 50 AND 100),
  CONSTRAINT "transformers_safety_margin_check" CHECK ("safety_margin_kw" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transformers_site" ON "transformers" USING btree ("site_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transformers_fed_from_panel" ON "transformers" USING btree ("fed_from_panel_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_energy_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "type" "energy_asset_type" NOT NULL,
  "name" varchar(60) NOT NULL,
  "capacity_kwh" integer,
  "peak_kwp" integer,
  "inverter_kw" numeric,
  "max_discharge_kw" numeric,
  "max_charge_kw" numeric,
  "phases" integer DEFAULT 3 NOT NULL,
  "connection_transformer_id" text,
  "connection_panel_id" text,
  "grid_charging" "energy_asset_grid_charging" DEFAULT 'possible' NOT NULL,
  "reserve_percent" integer DEFAULT 10 NOT NULL,
  "telemetry" "energy_asset_telemetry" DEFAULT 'none' NOT NULL,
  "reading_ttl_seconds" integer DEFAULT 60 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "site_energy_assets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "site_energy_assets_connection_transformer_id_transformers_id_fk" FOREIGN KEY ("connection_transformer_id") REFERENCES "public"."transformers"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "site_energy_assets_connection_panel_id_panels_id_fk" FOREIGN KEY ("connection_panel_id") REFERENCES "public"."panels"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "site_energy_assets_connection_check" CHECK ("connection_transformer_id" IS NULL OR "connection_panel_id" IS NULL),
  CONSTRAINT "site_energy_assets_type_fields_check" CHECK (("type" = 'battery' AND "peak_kwp" IS NULL) OR ("type" = 'solar' AND "capacity_kwh" IS NULL AND "max_discharge_kw" IS NULL AND "max_charge_kw" IS NULL)),
  CONSTRAINT "site_energy_assets_ratings_check" CHECK (("capacity_kwh" IS NULL OR "capacity_kwh" BETWEEN 1 AND 100000) AND ("peak_kwp" IS NULL OR "peak_kwp" BETWEEN 1 AND 100000) AND ("inverter_kw" IS NULL OR ("inverter_kw" > 0 AND "inverter_kw" <= 100000)) AND ("max_discharge_kw" IS NULL OR ("max_discharge_kw" > 0 AND "max_discharge_kw" <= 100000)) AND ("max_charge_kw" IS NULL OR ("max_charge_kw" > 0 AND "max_charge_kw" <= 100000))),
  CONSTRAINT "site_energy_assets_phases_check" CHECK ("phases" IN (1, 3)),
  CONSTRAINT "site_energy_assets_reserve_check" CHECK ("reserve_percent" BETWEEN 0 AND 100),
  CONSTRAINT "site_energy_assets_ttl_check" CHECK ("reading_ttl_seconds" BETWEEN 15 AND 600)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_site_energy_assets_site" ON "site_energy_assets" USING btree ("site_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "energy_asset_readings" (
  "asset_id" text PRIMARY KEY NOT NULL,
  "reported_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "power_kw" numeric NOT NULL,
  "available_kw" numeric,
  "soc_percent" numeric,
  "source" varchar(20) NOT NULL,
  "api_key_id" text,
  CONSTRAINT "energy_asset_readings_asset_id_site_energy_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."site_energy_assets"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "energy_asset_readings_source_check" CHECK ("source" IN ('api', 'simulated')),
  CONSTRAINT "energy_asset_readings_range_check" CHECK ("power_kw" BETWEEN -100000 AND 100000 AND ("available_kw" IS NULL OR "available_kw" BETWEEN 0 AND 100000) AND ("soc_percent" IS NULL OR "soc_percent" BETWEEN 0 AND 100))
);
--> statement-breakpoint
-- One service transformer per layout transformer still in the old form (a
-- name or a rating key), unlinked: a limit starts only when an operator links
-- it. The id comes from the site and the layout id, so the rewrite below
-- names the same row.
INSERT INTO "transformers" ("id", "site_id", "kind", "name", "rated_kva", "phases", "power_factor", "loading_limit_percent", "safety_margin_kw", "max_continuous_kw", "sort_order")
SELECT
  'tfm_' || substr(md5(s."id" || ':' || (e.elem->>'id')), 1, 12),
  s."id",
  'service',
  left(coalesce(nullif(btrim(e.elem->>'name'), ''), 'Transformer'), 60),
  r.kva,
  3,
  0.95,
  100,
  0,
  round(r.kva * 0.95, 3),
  (e.ord - 1)::integer
FROM "sites" s
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(s."layout_settings"->'transformers') = 'array'
    THEN s."layout_settings"->'transformers' ELSE '[]'::jsonb END
) WITH ORDINALITY AS e(elem, ord)
CROSS JOIN LATERAL (
  SELECT CASE WHEN jsonb_typeof(e.elem->'ratedKva') = 'number'
      AND (e.elem->>'ratedKva')::numeric BETWEEN 1 AND 100000
    THEN (e.elem->>'ratedKva')::numeric END AS kva
) r
WHERE jsonb_typeof(e.elem) = 'object'
  AND e.elem->>'id' IS NOT NULL
  AND (e.elem ? 'name' OR e.elem ? 'ratedKva')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- One informational energy asset (no connection, telemetry none) per layout
-- battery or solar canopy still in the old form (a type or a name key).
INSERT INTO "site_energy_assets" ("id", "site_id", "type", "name", "capacity_kwh", "peak_kwp", "grid_charging")
SELECT
  'ena_' || substr(md5(s."id" || ':' || (e.elem->>'id')), 1, 12),
  s."id",
  (e.elem->>'type')::"energy_asset_type",
  left(coalesce(nullif(btrim(e.elem->>'name'), ''),
    CASE WHEN e.elem->>'type' = 'battery' THEN 'Battery' ELSE 'Solar' END), 60),
  CASE WHEN e.elem->>'type' = 'battery' AND jsonb_typeof(e.elem->'capacityKwh') = 'number'
      AND (e.elem->>'capacityKwh')::numeric BETWEEN 1 AND 100000
    THEN round((e.elem->>'capacityKwh')::numeric)::integer END,
  CASE WHEN e.elem->>'type' = 'solar' AND jsonb_typeof(e.elem->'capacityKwp') = 'number'
      AND (e.elem->>'capacityKwp')::numeric BETWEEN 1 AND 100000
    THEN round((e.elem->>'capacityKwp')::numeric)::integer END,
  (CASE WHEN e.elem->>'type' = 'battery' THEN 'possible' ELSE 'never' END)::"energy_asset_grid_charging"
FROM "sites" s
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(s."layout_settings"->'energyAssets') = 'array'
    THEN s."layout_settings"->'energyAssets' ELSE '[]'::jsonb END
) AS e(elem)
WHERE jsonb_typeof(e.elem) = 'object'
  AND e.elem->>'id' IS NOT NULL
  AND e.elem->>'type' IN ('battery', 'solar')
  AND (e.elem ? 'type' OR e.elem ? 'name')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- The layout keeps only the positions: { id, x, z } for a transformer and
-- { id, x?, z?, row?, rotationDeg? } for an energy asset, naming the rows
-- above. Entries already in the new form stay; an old entry that could not
-- be moved (no id, an unknown type) is dropped.
UPDATE "sites" s SET "layout_settings" = jsonb_set(s."layout_settings", '{transformers}', (
  SELECT coalesce(jsonb_agg(
    CASE WHEN e.elem ? 'name' OR e.elem ? 'ratedKva'
      THEN jsonb_strip_nulls(jsonb_build_object(
        'id', 'tfm_' || substr(md5(s."id" || ':' || (e.elem->>'id')), 1, 12),
        'x', e.elem->'x',
        'z', e.elem->'z'))
      ELSE e.elem END
    ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements(s."layout_settings"->'transformers') WITH ORDINALITY AS e(elem, ord)
  WHERE jsonb_typeof(e.elem) = 'object' AND e.elem->>'id' IS NOT NULL
))
WHERE jsonb_typeof(s."layout_settings"->'transformers') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(s."layout_settings"->'transformers') = 'array'
        THEN s."layout_settings"->'transformers' ELSE '[]'::jsonb END
    ) AS e(elem)
    WHERE jsonb_typeof(e.elem) <> 'object' OR e.elem->>'id' IS NULL
      OR e.elem ? 'name' OR e.elem ? 'ratedKva'
  );
--> statement-breakpoint
UPDATE "sites" s SET "layout_settings" = jsonb_set(s."layout_settings", '{energyAssets}', (
  SELECT coalesce(jsonb_agg(
    CASE WHEN e.elem ? 'type' OR e.elem ? 'name'
      THEN jsonb_strip_nulls(jsonb_build_object(
        'id', 'ena_' || substr(md5(s."id" || ':' || (e.elem->>'id')), 1, 12),
        'x', e.elem->'x',
        'z', e.elem->'z',
        'row', e.elem->'row',
        'rotationDeg', e.elem->'rotationDeg'))
      ELSE e.elem END
    ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements(s."layout_settings"->'energyAssets') WITH ORDINALITY AS e(elem, ord)
  WHERE jsonb_typeof(e.elem) = 'object' AND e.elem->>'id' IS NOT NULL
    AND (NOT (e.elem ? 'type' OR e.elem ? 'name') OR e.elem->>'type' IN ('battery', 'solar'))
))
WHERE jsonb_typeof(s."layout_settings"->'energyAssets') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(s."layout_settings"->'energyAssets') = 'array'
        THEN s."layout_settings"->'energyAssets' ELSE '[]'::jsonb END
    ) AS e(elem)
    WHERE jsonb_typeof(e.elem) <> 'object' OR e.elem->>'id' IS NULL
      OR e.elem ? 'type' OR e.elem ? 'name'
  );
--> statement-breakpoint
-- The transformer that feeds a panel (a service transformer above a
-- top-level panel, a step-down transformer above a sub-panel).
ALTER TABLE "panels" ADD COLUMN IF NOT EXISTS "transformer_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "panels" ADD CONSTRAINT "panels_transformer_id_transformers_id_fk"
    FOREIGN KEY ("transformer_id") REFERENCES "public"."transformers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_panels_transformer" ON "panels" USING btree ("transformer_id");
--> statement-breakpoint
-- Battery and solar supply credited in each allocation, kW. A constant
-- default adds the column without rewriting the table.
ALTER TABLE "load_allocation_log" ADD COLUMN IF NOT EXISTS "supply_credit_kw" numeric DEFAULT '0' NOT NULL;
