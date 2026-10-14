-- v0.1.46 release migration. One file for the whole release: extend it in place
-- during the release cycle, every statement idempotent.

-- Contract step of v0.1.45: the AI Inbox and the MCP write proposals are gone,
-- and every install runs v0.1.45 first, so no pod reads or inserts these
-- columns any more. Dropping a column also drops its foreign key, its check
-- constraint (ai_proposals_source_check) and any index on it.
ALTER TABLE "ai_proposals" DROP COLUMN IF EXISTS "source";
--> statement-breakpoint
ALTER TABLE "ai_proposals" DROP COLUMN IF EXISTS "requested_by_user_id";
--> statement-breakpoint
ALTER TABLE "ai_proposals" DROP COLUMN IF EXISTS "api_key_id";
--> statement-breakpoint
ALTER TABLE "ai_proposals" DROP COLUMN IF EXISTS "rationale_text";
--> statement-breakpoint
ALTER TABLE "ai_proposals" DROP COLUMN IF EXISTS "rationale_language";
--> statement-breakpoint
ALTER TABLE "ai_mcp_calls" DROP COLUMN IF EXISTS "proposal_id";
--> statement-breakpoint
-- Fleet booking status, derived from the slots (scheduled, active, partial,
-- completed, expired, cancelled). The one-time backfill runs only while the
-- check does not exist yet, so a rerun changes nothing. It derives every
-- booking not yet final from its slots, as the services helper does, then
-- the check holds the set.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleet_reservations_status_check'
  ) THEN
    UPDATE "fleet_reservations" fr
    SET "status" = d.status, "updated_at" = now()
    FROM (
      SELECT f.id,
        CASE
          WHEN count(r.id) FILTER (WHERE r.status IN ('scheduled', 'active', 'in_use')) > 0 THEN
            CASE
              WHEN count(r.id) FILTER (WHERE r.status IN ('cancelled', 'expired')) > 0 THEN 'partial'
              WHEN count(r.id) FILTER (WHERE r.status IN ('active', 'in_use')) > 0 THEN 'active'
              ELSE 'scheduled'
            END
          WHEN count(r.id) FILTER (WHERE r.status = 'used') > 0 THEN 'completed'
          WHEN count(r.id) FILTER (WHERE r.status = 'expired') > 0 THEN 'expired'
          ELSE 'cancelled'
        END AS status
      FROM "fleet_reservations" f
      LEFT JOIN "reservations" r ON r.fleet_reservation_id = f.id
      WHERE f.status NOT IN ('completed', 'expired', 'cancelled')
      GROUP BY f.id
    ) d
    WHERE fr.id = d.id AND fr.status IS DISTINCT FROM d.status;
    ALTER TABLE "fleet_reservations" ADD CONSTRAINT "fleet_reservations_status_check"
      CHECK ("status" IN ('scheduled', 'active', 'partial', 'completed', 'expired', 'cancelled'));
  END IF;
END $$;
--> statement-breakpoint
-- Member invoices (a fleet that invoices each member, discussion #12). Every
-- default keeps v0.1.45 behavior: each fleet stays 'fleet', no session or
-- invoice is member billed. No statement of this file uses the audit value.
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'billing_address_updated';
--> statement-breakpoint
-- Firmware updates a station never started (refused UpdateFirmware, command
-- error, expired queued command) end as 'Rejected', so their campaign
-- completes. No statement of this file uses the value.
ALTER TYPE "firmware_update_status" ADD VALUE IF NOT EXISTS 'Rejected';
--> statement-breakpoint
-- Firmware campaign download retries, retry interval and install time. Null
-- keeps v0.1.45 behavior (the station decides, installs when it can).
ALTER TABLE "firmware_campaigns" ADD COLUMN IF NOT EXISTS "retries" integer;
--> statement-breakpoint
ALTER TABLE "firmware_campaigns" ADD COLUMN IF NOT EXISTS "retry_interval" integer;
--> statement-breakpoint
ALTER TABLE "firmware_campaigns" ADD COLUMN IF NOT EXISTS "install_date_time" timestamp with time zone;
--> statement-breakpoint
-- A campaign station offline at the start gets its update when it connects.
-- Every station row of v0.1.45 was dispatched at the start, so the one-time
-- backfill (while the column is new) marks them all dispatched.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'firmware_campaign_stations'
      AND column_name = 'dispatched_at'
  ) THEN
    ALTER TABLE "firmware_campaign_stations" ADD COLUMN "dispatched_at" timestamp with time zone;
    UPDATE "firmware_campaign_stations" SET "dispatched_at" = "updated_at";
  END IF;
END $$;
--> statement-breakpoint
-- One row per station and campaign, so the connect-time dispatch claims it
-- once. A duplicate (a concurrent start before the start was guarded) keeps
-- its oldest row.
DELETE FROM "firmware_campaign_stations" a
USING "firmware_campaign_stations" b
WHERE a.campaign_id = b.campaign_id AND a.station_id = b.station_id AND a.id > b.id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_firmware_campaign_stations_campaign_station"
  ON "firmware_campaign_stations" ("campaign_id", "station_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fleet_member_invoice_run_failures" (
  "fleet_id" text NOT NULL,
  "driver_id" text NOT NULL,
  "period_start" date NOT NULL,
  "invoice_number" text,
  "error_message" text NOT NULL,
  "failed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reported_at" timestamp with time zone,
  CONSTRAINT "fleet_member_invoice_run_failures_pkey" PRIMARY KEY ("fleet_id", "driver_id", "period_start")
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleet_member_invoice_run_failures_fleet_id_fleets_id_fk'
  ) THEN
    ALTER TABLE "fleet_member_invoice_run_failures"
      ADD CONSTRAINT "fleet_member_invoice_run_failures_fleet_id_fleets_id_fk"
      FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleet_member_invoice_run_failures_driver_id_drivers_id_fk'
  ) THEN
    ALTER TABLE "fleet_member_invoice_run_failures"
      ADD CONSTRAINT "fleet_member_invoice_run_failures_driver_id_drivers_id_fk"
      FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fleet_member_invoice_run_failures_unreported"
  ON "fleet_member_invoice_run_failures" ("failed_at") WHERE "reported_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "account_invoice_recipient" varchar(8) DEFAULT 'fleet' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleets_account_invoice_recipient_check'
  ) THEN
    ALTER TABLE "fleets" ADD CONSTRAINT "fleets_account_invoice_recipient_check"
      CHECK ("account_invoice_recipient" IN ('fleet', 'member'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "billing_name" varchar(255);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "billing_street" varchar(255);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "billing_city" varchar(100);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "billing_state" varchar(100);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "billing_zip" varchar(20);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "billing_country" varchar(100);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "member_billed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_member_billed_check'
  ) THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_member_billed_check"
      CHECK (NOT "member_billed" OR "fleet_id" IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
-- The fleet period index leaves member invoices out. Same name, so v0.1.45
-- pods keep mapping its unique violation. Swapped only while it lacks the
-- member condition, so a rerun keeps it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'uq_invoices_fleet_period'
      AND indexdef LIKE '%member_billed%'
  ) THEN
    DROP INDEX IF EXISTS "uq_invoices_fleet_period";
    CREATE UNIQUE INDEX "uq_invoices_fleet_period" ON "invoices" ("fleet_id", "period_start")
      WHERE fleet_id IS NOT NULL AND kind = 'invoice' AND status NOT IN ('void', 'credited') AND NOT member_billed;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoices_member_period" ON "invoices" ("fleet_id", "driver_id", "period_start")
  WHERE member_billed AND kind = 'invoice' AND status NOT IN ('void', 'credited');
--> statement-breakpoint
ANALYZE "invoices";
--> statement-breakpoint
-- Load management: the allocations last sent to the stations, shared by every
-- worker process (the in-process cache skipped a send when two workers
-- alternated, and never resent a lost one). Nullable, no default: no rewrite.
ALTER TABLE "site_load_management" ADD COLUMN IF NOT EXISTS "applied_allocations" jsonb;
--> statement-breakpoint
ALTER TABLE "site_load_management" ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone;
--> statement-breakpoint
-- A three-phase panel takes its phase to neutral voltage. 208 and 480 are line
-- to line voltages (208Y/120, 480Y/277), so a three-phase panel saved with one
-- overstated its capacity by a factor of 1.73: store the phase to neutral
-- voltage and recompute the capacity. A rerun finds no such panel.
UPDATE "panels"
SET "voltage_v" = CASE "voltage_v" WHEN 208 THEN 120 ELSE 277 END,
  "max_continuous_kw" = ("breaker_rating_amps" * (CASE "voltage_v" WHEN 208 THEN 120 ELSE 277 END) * 3 * 0.8 / 1000)::numeric,
  "updated_at" = now()
WHERE "phases" = 3 AND "voltage_v" IN (208, 480);
--> statement-breakpoint
-- A circuit's capacity counts the phases it uses: one phase V x A, two phases
-- the line to line voltage (sqrt(3) x V) x A, three phases 3 x V x A. A
-- circuit on one or two phases of a three-phase panel was counted on all
-- three. Recompute every circuit of a three-phase panel; the guard makes a
-- rerun change nothing.
UPDATE "circuits" c
SET "max_continuous_kw" = v.kw, "updated_at" = now()
FROM (
  SELECT c2.id,
    round((c2.breaker_rating_amps * p.voltage_v
      * CASE
          WHEN c2.phase_connections IN ('L1', 'L2', 'L3') THEN 1
          WHEN c2.phase_connections IN ('L1L2', 'L1L3', 'L2L3') THEN sqrt(3)
          ELSE 3
        END * 0.8 / 1000)::numeric, 6) AS kw
  FROM "circuits" c2
  JOIN "panels" p ON p.id = c2.panel_id
  WHERE p.phases = 3
) v
WHERE c.id = v.id AND round(c.max_continuous_kw, 6) IS DISTINCT FROM v.kw;
--> statement-breakpoint
-- Retention of the load allocation log, pruned by the daily log-retention-prune
-- cron. An operator value already set stays.
INSERT INTO settings (key, value) VALUES ('logs.loadAllocation.retentionDays', '90'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Cron that ends charging profile pushes an API restart cut off
-- (handlers/charging-profile-push-sweep.ts), every 5 minutes.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'charging-profile-push-sweep', '*/5 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'charging-profile-push-sweep');
--> statement-breakpoint
-- Load management minimum power per station (null: no minimum). Nullable
-- without a default: no rewrite.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "load_min_power_kw" numeric;
--> statement-breakpoint
-- The ISO 15118 TxProfile the CSMS sent for the EV's charging needs, so the
-- schedule the EV reports back is checked against it (K15.FR.11/12).
ALTER TABLE "ev_charging_needs" ADD COLUMN IF NOT EXISTS "csms_charging_profile" jsonb;
--> statement-breakpoint
ALTER TABLE "ev_charging_schedules" ADD COLUMN IF NOT EXISTS "within_limits" boolean;
--> statement-breakpoint
-- Complete audit coverage: the actions of the operator, driver and system
-- writes that had no audit row. No statement of this file uses the values.
ALTER TYPE "site_audit_action" ADD VALUE IF NOT EXISTS 'load_management_changed';
--> statement-breakpoint
ALTER TYPE "site_audit_action" ADD VALUE IF NOT EXISTS 'location_published_changed';
--> statement-breakpoint
ALTER TYPE "site_audit_action" ADD VALUE IF NOT EXISTS 'electricity_rates_changed';
--> statement-breakpoint
ALTER TYPE "site_audit_action" ADD VALUE IF NOT EXISTS 'payout_status_changed';
--> statement-breakpoint
ALTER TYPE "station_audit_action" ADD VALUE IF NOT EXISTS 'display_message_set';
--> statement-breakpoint
ALTER TYPE "station_audit_action" ADD VALUE IF NOT EXISTS 'display_message_cleared';
--> statement-breakpoint
ALTER TYPE "station_audit_action" ADD VALUE IF NOT EXISTS 'nevi_data_changed';
--> statement-breakpoint
ALTER TYPE "station_audit_action" ADD VALUE IF NOT EXISTS 'evse_changed';
--> statement-breakpoint
ALTER TYPE "station_audit_action" ADD VALUE IF NOT EXISTS 'monitoring_changed';
--> statement-breakpoint
ALTER TYPE "station_audit_action" ADD VALUE IF NOT EXISTS 'alert_acknowledged';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'payment_method_added';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'payment_method_removed';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'payment_method_default_changed';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'pnc_contract_issued';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'pnc_contract_revoked';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'login_succeeded';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'login_failed';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'mfa_enabled';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'mfa_disabled';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'roaming_session_started';
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'invite_resent';
--> statement-breakpoint
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'cdr_credited';
--> statement-breakpoint
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'faulted';
--> statement-breakpoint
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'stopped_by_csms';
--> statement-breakpoint
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'vehicle_changed';
--> statement-breakpoint
ALTER TYPE "tariff_audit_action" ADD VALUE IF NOT EXISTS 'tariff_mapping_changed';
--> statement-breakpoint
ALTER TYPE "pricing_group_audit_action" ADD VALUE IF NOT EXISTS 'tariff_mapping_changed';
--> statement-breakpoint
ALTER TYPE "certificate_audit_action" ADD VALUE IF NOT EXISTS 'expired';
--> statement-breakpoint
ALTER TYPE "support_case_audit_action" ADD VALUE IF NOT EXISTS 'attachment_deleted';
--> statement-breakpoint
ALTER TYPE "ai_conversation_audit_action" ADD VALUE IF NOT EXISTS 'attachment_deleted';
--> statement-breakpoint
-- New audited entity: every transition of a payment record (session, reservation fee, ad hoc and guest
-- payments), keyed by the payment record id.
DO $$ BEGIN
  CREATE TYPE "payment_audit_action" AS ENUM ('created', 'pre_authorized', 'captured', 'partially_refunded', 'refunded', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "payment_id" text,
  "payment_id_snapshot" text NOT NULL,
  "action" "payment_audit_action" NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_payment_audit_entity_id" ON "payment_audit_log" ("payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_audit_created_at" ON "payment_audit_log" ("created_at");
--> statement-breakpoint
-- New audited entity: notification templates and event settings, keyed by the event type.
DO $$ BEGIN
  CREATE TYPE "notification_template_audit_action" AS ENUM ('updated', 'deleted', 'event_settings_changed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_template_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "notification_template_id" text,
  "notification_template_id_snapshot" text NOT NULL,
  "action" "notification_template_audit_action" NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_notification_template_audit_entity_id" ON "notification_template_audit_log" ("notification_template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_template_audit_created_at" ON "notification_template_audit_log" ("created_at");
--> statement-breakpoint
-- New audited entity: station message templates, keyed by the state.
DO $$ BEGIN
  CREATE TYPE "station_message_template_audit_action" AS ENUM ('updated', 'reset');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "station_message_template_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "station_message_template_id" text,
  "station_message_template_id_snapshot" text NOT NULL,
  "action" "station_message_template_audit_action" NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_station_message_template_audit_entity_id" ON "station_message_template_audit_log" ("station_message_template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_message_template_audit_created_at" ON "station_message_template_audit_log" ("created_at");
--> statement-breakpoint
-- New audited entity: station event alert rules.
DO $$ BEGIN
  CREATE TYPE "event_alert_rule_audit_action" AS ENUM ('created', 'updated', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_alert_rule_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "event_alert_rule_id" text,
  "event_alert_rule_id_snapshot" text NOT NULL,
  "action" "event_alert_rule_audit_action" NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_event_alert_rule_audit_entity_id" ON "event_alert_rule_audit_log" ("event_alert_rule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_event_alert_rule_audit_created_at" ON "event_alert_rule_audit_log" ("created_at");
--> statement-breakpoint
-- New audited entity: report schedules and deleted reports.
DO $$ BEGIN
  CREATE TYPE "report_schedule_audit_action" AS ENUM ('created', 'updated', 'deleted', 'report_deleted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_schedule_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "report_schedule_id" text,
  "report_schedule_id_snapshot" text NOT NULL,
  "action" "report_schedule_audit_action" NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_report_schedule_audit_entity_id" ON "report_schedule_audit_log" ("report_schedule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_report_schedule_audit_created_at" ON "report_schedule_audit_log" ("created_at");
--> statement-breakpoint
-- Retention of the login audit rows (user and driver login_succeeded and
-- login_failed), pruned by the daily log-retention-prune cron. 0 keeps them.
-- An operator value already set stays.
INSERT INTO settings (key, value) VALUES ('logs.loginAudit.retentionDays', '90'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Last: the hot table's ACCESS EXCLUSIVE lock is held to the commit. A constant
-- default needs no rewrite. The check is NOT VALID (no scan) and enforced on
-- new writes; VALIDATE CONSTRAINT is a v0.1.47 contract step.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "member_billed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'charging_sessions_member_billed_check'
  ) THEN
    ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_member_billed_check"
      CHECK (NOT "member_billed" OR (coalesce("billing_mode" = 'account', false) AND "driver_id" IS NOT NULL))
      NOT VALID;
  END IF;
END $$;
