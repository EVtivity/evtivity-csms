-- v0.1.53 release migration. Idempotent: every statement can run again.

-- v0.1.53 report period, block A: the company week start (Settings > Company).
-- A fresh install starts on Monday; a stored choice is kept.
INSERT INTO "settings" ("key", "value") VALUES ('company.weekStart', '"monday"'::jsonb)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- end of report period block A

-- v0.1.53 report period, block B: the period of a report schedule. Existing
-- schedules keep their fixed dates as custom.
-- Fixed dates stored as timestamps (an API or assistant client) become the
-- company-local day they fall on, so the stricter day filter keeps them. A value
-- that is no ISO date and time stays and is counted.
DO $$
DECLARE
  tz text;
  r record;
  k text;
  v text;
  day date;
  changed jsonb;
  converted integer := 0;
  unparsable integer := 0;
BEGIN
  SELECT value #>> '{}' INTO tz FROM settings WHERE key = 'system.timezone';
  BEGIN
    PERFORM now() AT TIME ZONE tz;
  EXCEPTION WHEN others THEN
    tz := NULL;
  END;
  tz := COALESCE(tz, 'America/New_York');
  FOR r IN
    SELECT id, filters FROM report_schedules
    WHERE jsonb_typeof(filters) = 'object'
      AND (
        (filters ? 'dateFrom' AND filters ->> 'dateFrom' !~ '^\d{4}-\d{2}-\d{2}$')
        OR (filters ? 'dateTo' AND filters ->> 'dateTo' !~ '^\d{4}-\d{2}-\d{2}$')
      )
  LOOP
    changed := r.filters;
    FOREACH k IN ARRAY ARRAY['dateFrom', 'dateTo'] LOOP
      v := r.filters ->> k;
      CONTINUE WHEN v IS NULL OR jsonb_typeof(r.filters -> k) = 'null' OR v ~ '^\d{4}-\d{2}-\d{2}$';
      -- Only an ISO date and time: Postgres also reads words such as 'yesterday'.
      IF v !~ '^\d{4}-\d{2}-\d{2}[T ]' THEN
        unparsable := unparsable + 1;
        CONTINUE;
      END IF;
      BEGIN
        day := (v::timestamptz AT TIME ZONE tz)::date;
        changed := jsonb_set(changed, ARRAY[k], to_jsonb(to_char(day, 'YYYY-MM-DD')));
        converted := converted + 1;
      EXCEPTION WHEN others THEN
        unparsable := unparsable + 1;
      END;
    END LOOP;
    IF changed IS DISTINCT FROM r.filters THEN
      UPDATE report_schedules SET filters = changed WHERE id = r.id;
    END IF;
  END LOOP;
  IF converted > 0 OR unparsable > 0 THEN
    RAISE NOTICE 'report schedule dates: % converted to company days, % left as they are (not a timestamp)',
      converted, unparsable;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "report_schedules"
  ADD COLUMN IF NOT EXISTS "report_period" varchar(32) NOT NULL DEFAULT 'custom';
--> statement-breakpoint
ALTER TABLE "report_schedules" DROP CONSTRAINT IF EXISTS "report_schedules_report_period_check";
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_report_period_check"
  CHECK ("report_period" IN ('previousDay', 'previousWeek', 'previousMonth', 'previousQuarter',
    'previousYear', 'currentWeekToDate', 'currentMonthToDate', 'currentYearToDate',
    'last7Days', 'last30Days', 'custom'));
--> statement-breakpoint
-- end of report period block B
--
-- v0.1.53 load management, block A: tariff current limits and per-EVSE balancing.
-- The maximum charging current of a session on a tariff, A per phase (6 to 500),
-- applied by load management; null is no limit. A DC tariff takes none.
ALTER TABLE "tariffs" ADD COLUMN IF NOT EXISTS "max_current_a" numeric(5, 1);
--> statement-breakpoint
ALTER TABLE "tariffs" DROP CONSTRAINT IF EXISTS "tariffs_max_current_a_check";
--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_max_current_a_check"
  CHECK ("max_current_a" IS NULL OR ("max_current_a" >= 6 AND "max_current_a" <= 500));
--> statement-breakpoint
ALTER TABLE "tariffs" DROP CONSTRAINT IF EXISTS "tariffs_max_current_a_dc_check";
--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_max_current_a_dc_check"
  CHECK ("max_current_a" IS NULL OR "charging_type" <> 'dc');
--> statement-breakpoint
-- The limit is copied with the prices when a session or a tariff segment opens,
-- so a tariff edit never changes a running session. Null on every existing row.
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "max_current_a" numeric(5, 1);
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "tariff_max_current_a" numeric(5, 1);
--> statement-breakpoint
-- The phases a session charges on, from the station's per-phase current readings.
-- Null: not known, counted on every phase of its circuit.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "ev_phases" varchar(6);
--> statement-breakpoint
-- Added NOT VALID only while missing (no scan under this file's locks); the
-- 0493 file validates it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_ev_phases_check'
      AND conrelid = 'charging_sessions'::regclass
  ) THEN
    ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_ev_phases_check"
      CHECK ("ev_phases" IS NULL OR "ev_phases" IN ('L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3', 'L1L2L3')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- How load management limits a station: 'station' one limit for the whole
-- station (every station before v0.1.53), 'evse' a limit per charging EVSE.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "load_balancing_mode" varchar(8) NOT NULL DEFAULT 'station';
--> statement-breakpoint
ALTER TABLE "charging_stations" DROP CONSTRAINT IF EXISTS "charging_stations_load_balancing_mode_check";
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD CONSTRAINT "charging_stations_load_balancing_mode_check"
  CHECK ("load_balancing_mode" IN ('station', 'evse'));
--> statement-breakpoint
-- Set when the station refused a per-EVSE limit: load management falls back to
-- one station limit until it is cleared.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "evse_limits_refused_at" timestamptz;
--> statement-breakpoint
-- Per-EVSE limits refused in a row for live transactions; three put the station
-- on one station limit (evse_limits_refused_at).
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "evse_limit_refusals" smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
-- When the last per-EVSE limit refusal was counted: a count older than 24 hours
-- starts again at the next refusal.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "evse_limit_refusal_at" timestamptz;
--> statement-breakpoint
-- How the stations of a circuit are wired to the panel phases, set by the
-- operator over what the stations report (PhaseRotation, ConnectorPhaseRotation).
-- Null: the reported rotation, else not known.
ALTER TABLE "circuits" ADD COLUMN IF NOT EXISTS "phase_rotation" varchar(3);
--> statement-breakpoint
ALTER TABLE "circuits" DROP CONSTRAINT IF EXISTS "circuits_phase_rotation_check";
--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_phase_rotation_check"
  CHECK ("phase_rotation" IS NULL OR "phase_rotation" IN ('RST', 'RTS', 'SRT', 'STR', 'TRS', 'TSR'));
--> statement-breakpoint
-- When an event last asked for the site's allocation to be computed again; a
-- cycle that started before it runs once more.
ALTER TABLE "site_load_management" ADD COLUMN IF NOT EXISTS "recompute_requested_at" timestamptz;
--> statement-breakpoint
-- Raised by each holder of the site lock; a claim of an older holder writes and sends nothing.
ALTER TABLE "site_load_management" ADD COLUMN IF NOT EXISTS "cycle_fence" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- New batteries and solar arrays keep a reading fresh for 120 s: a credit needs
-- more than the 60 s clock margin plus one 10 s cycle. Existing assets keep theirs.
ALTER TABLE "site_energy_assets" ALTER COLUMN "reading_ttl_seconds" SET DEFAULT 120;
-- end of load management block A
--> statement-breakpoint
-- v0.1.53 load management, block B: Station Unit budgets.
-- The most one physical charger box takes, shared by its EVSEs: AC in A per
-- phase on 1 or 3 phases, DC in kW. A deleted unit or station drops its budget.
CREATE TABLE IF NOT EXISTS "station_unit_load_budgets" (
  "unit_id" text PRIMARY KEY NOT NULL,
  "station_id" text NOT NULL,
  "kind" varchar(2) NOT NULL,
  "max_current_a" numeric(5, 1),
  "phases" smallint,
  "max_power_kw" numeric(8, 2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "station_unit_load_budgets_unit_fk" FOREIGN KEY ("unit_id", "station_id")
    REFERENCES "station_units" ("id", "station_id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "station_unit_load_budgets" DROP CONSTRAINT IF EXISTS "station_unit_load_budgets_shape_check";
--> statement-breakpoint
ALTER TABLE "station_unit_load_budgets" ADD CONSTRAINT "station_unit_load_budgets_shape_check" CHECK (
  ("kind" = 'ac' AND "max_current_a" IS NOT NULL AND "phases" IS NOT NULL
    AND "max_current_a" BETWEEN 6 AND 1000 AND "phases" IN (1, 3) AND "max_power_kw" IS NULL)
  OR ("kind" = 'dc' AND "max_power_kw" IS NOT NULL AND "max_power_kw" > 0 AND "max_power_kw" <= 5000
    AND "max_current_a" IS NULL AND "phases" IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_unit_load_budgets_station" ON "station_unit_load_budgets" ("station_id");
-- end of load management block B
--> statement-breakpoint
-- v0.1.53 load management, block C: every limit load management sends, per
-- station and EVSE, with the station's reply. The header row of a send keeps
-- the site totals; the per-station summary moves to the entries, so the old
-- jsonb is null on new rows (v0.1.52 workers still write it during an upgrade).
ALTER TABLE "load_allocation_log" ALTER COLUMN "allocations" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "load_allocation_log" ADD COLUMN IF NOT EXISTS "kind" varchar(8) NOT NULL DEFAULT 'change';
--> statement-breakpoint
-- Added NOT VALID only while missing (no scan under this file's locks); the
-- 0493 file validates it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'load_allocation_log_kind_check'
      AND conrelid = 'load_allocation_log'::regclass
  ) THEN
    ALTER TABLE "load_allocation_log" ADD CONSTRAINT "load_allocation_log_kind_check"
      CHECK ("kind" IN ('change', 'refresh', 'credit')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "load_allocation_entries" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "log_id" integer NOT NULL REFERENCES "load_allocation_log" ("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "site_id" text NOT NULL REFERENCES "sites" ("id") ON DELETE CASCADE,
  "station_id" text REFERENCES "charging_stations" ("id") ON DELETE SET NULL,
  "station_ocpp_id" varchar(48) NOT NULL,
  "unit_id" text,
  "unit_name" varchar(50),
  "evse_number" integer,
  "scope" varchar(8) NOT NULL,
  "mode" varchar(8) NOT NULL,
  "limit_kw" numeric(10, 3) NOT NULL,
  "limit_a" numeric(6, 1),
  "phases" smallint,
  "rate_unit" varchar(1) NOT NULL,
  "reason" varchar(20) NOT NULL,
  "session_id" text REFERENCES "charging_sessions" ("id") ON DELETE SET NULL,
  "tariff_id" text,
  "tariff_max_current_a" numeric(5, 1),
  "profile_id" bigint NOT NULL,
  "stack_level" smallint NOT NULL,
  "purpose" varchar(40) NOT NULL,
  "command_id" text,
  "reply" varchar(10),
  "replied_at" timestamp with time zone,
  "refresh" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" DROP CONSTRAINT IF EXISTS "load_allocation_entries_scope_check";
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" ADD CONSTRAINT "load_allocation_entries_scope_check"
  CHECK ("scope" IN ('station', 'evse'));
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" DROP CONSTRAINT IF EXISTS "load_allocation_entries_mode_check";
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" ADD CONSTRAINT "load_allocation_entries_mode_check"
  CHECK ("mode" IN ('station', 'evse'));
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" DROP CONSTRAINT IF EXISTS "load_allocation_entries_rate_unit_check";
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" ADD CONSTRAINT "load_allocation_entries_rate_unit_check"
  CHECK ("rate_unit" IN ('A', 'W'));
--> statement-breakpoint
-- The list of @evtivity/lib/load-allocation-reasons.
ALTER TABLE "load_allocation_entries" DROP CONSTRAINT IF EXISTS "load_allocation_entries_reason_check";
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" ADD CONSTRAINT "load_allocation_entries_reason_check"
  CHECK ("reason" IN ('tariff_limit', 'unit_budget', 'station_share', 'circuit_limit',
    'panel_limit', 'transformer_limit', 'ac_min_pause', 'min_power_stop', 'depot_plan',
    'station_max', 'connector_max', 'reserved', 'idle_allowance', 'measured_draw'));
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" DROP CONSTRAINT IF EXISTS "load_allocation_entries_reply_check";
--> statement-breakpoint
ALTER TABLE "load_allocation_entries" ADD CONSTRAINT "load_allocation_entries_reply_check"
  CHECK ("reply" IS NULL OR "reply" IN ('accepted', 'rejected', 'not_sent'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_load_alloc_entries_site_created" ON "load_allocation_entries" ("site_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_load_alloc_entries_station_created" ON "load_allocation_entries" ("station_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_load_alloc_entries_created" ON "load_allocation_entries" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_load_alloc_entries_command" ON "load_allocation_entries" ("command_id")
  WHERE "command_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_load_alloc_entries_log" ON "load_allocation_entries" ("log_id");
-- end of load management block C
--> statement-breakpoint
-- v0.1.53 vehicle AC phases: the AC phases the vehicle's onboard charger uses
-- (1 or 3). Null on every existing row: not known.
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "ac_phases" smallint;
--> statement-breakpoint
ALTER TABLE "vehicles" DROP CONSTRAINT IF EXISTS "vehicles_ac_phases_check";
--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_ac_phases_check"
  CHECK ("ac_phases" IS NULL OR "ac_phases" IN (1, 3));
-- end of vehicle AC phases block
--> statement-breakpoint
-- v0.1.53 load management, block D: the limit state records. Every stored
-- station entry without a `limit` record (written by an earlier build) gets
-- the safest state its old fields allow: refused while its limit was pending,
-- unknown while unconfirmed at no known kW, else lost at the highest kW it
-- stored (it may hold any of them); EVSE entries are lost at their limit; a
-- credit profile is kept with its end. The old fields go, and the site sends
-- on its next cycle. Entries that hold a record are left alone, so a rerun
-- changes nothing.
CREATE OR REPLACE FUNCTION pg_temp.evtivity_0492_limit_entry(e jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  kw numeric;
  rec jsonb;
  out jsonb;
  evses jsonb;
BEGIN
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e ? 'limit' THEN
    RETURN e;
  END IF;
  kw := GREATEST(
    CASE WHEN jsonb_typeof(e -> 'allocatedKw') = 'number' THEN (e ->> 'allocatedKw')::numeric END,
    CASE WHEN jsonb_typeof(e -> 'sentKw') = 'number' THEN (e ->> 'sentKw')::numeric END,
    CASE WHEN jsonb_typeof(e -> 'confirmedKw') = 'number' THEN (e ->> 'confirmedKw')::numeric END,
    CASE WHEN jsonb_typeof(e -> 'previousKw') = 'number' THEN (e ->> 'previousKw')::numeric END,
    CASE WHEN jsonb_typeof(e -> 'unconfirmedKw') = 'number' THEN (e ->> 'unconfirmedKw')::numeric END
  );
  IF e -> 'limitPending' = 'true'::jsonb THEN
    rec := jsonb_build_object('state', 'refused', 'mightKw', NULL);
  ELSIF e -> 'unconfirmed' = 'true'::jsonb
    AND jsonb_typeof(e -> 'unconfirmedKw') IS DISTINCT FROM 'number' THEN
    rec := jsonb_build_object('state', 'unknown', 'mightKw', NULL);
  ELSIF kw IS NULL THEN
    rec := jsonb_build_object('state', 'unknown', 'mightKw', NULL);
  ELSE
    rec := jsonb_build_object('state', 'lost', 'mightKw', kw);
  END IF;
  out := (e - 'sentKw' - 'sentLimit' - 'sentUnit' - 'sentCommandId' - 'awaitingReply'
    - 'confirmedKw' - 'previousKw' - 'unconfirmed' - 'unconfirmedKw' - 'limitPending'
    - 'baseKw' - 'creditUntil') || jsonb_build_object('limit', rec);
  IF jsonb_typeof(e -> 'baseKw') = 'number' THEN
    out := out || jsonb_build_object('allocatedBaseKw', e -> 'baseKw');
  END IF;
  IF jsonb_typeof(e -> 'creditUntil') = 'string' AND jsonb_typeof(e -> 'allocatedKw') = 'number' THEN
    out := out || jsonb_build_object(
      'credit', jsonb_build_object(
        'limit', jsonb_build_object('state', 'lost', 'mightKw', e -> 'allocatedKw'),
        'until', e -> 'creditUntil'));
  END IF;
  IF jsonb_typeof(e -> 'evses') = 'array' THEN
    SELECT COALESCE(jsonb_agg(
      CASE WHEN jsonb_typeof(v.x) = 'object' AND NOT (v.x ? 'limit')
        AND jsonb_typeof(v.x -> 'limitKw') = 'number'
        THEN v.x || jsonb_build_object('limit',
          jsonb_build_object('state', 'lost', 'mightKw', v.x -> 'limitKw'))
        ELSE v.x END
      ORDER BY v.ord), '[]'::jsonb)
    INTO evses
    FROM jsonb_array_elements(e -> 'evses') WITH ORDINALITY AS v(x, ord);
    out := out || jsonb_build_object('evses', evses);
  END IF;
  RETURN out;
END;
$$;
--> statement-breakpoint
UPDATE site_load_management slm
SET applied_allocations = (
      SELECT jsonb_agg(pg_temp.evtivity_0492_limit_entry(t.e) ORDER BY t.ord)
      FROM jsonb_array_elements(slm.applied_allocations) WITH ORDINALITY AS t(e, ord)
    ),
    applied_at = NULL
WHERE jsonb_typeof(slm.applied_allocations) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(slm.applied_allocations) AS x(e)
    WHERE jsonb_typeof(x.e) = 'object' AND NOT (x.e ? 'limit')
  );
-- end of load management block D
