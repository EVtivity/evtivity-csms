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
-- Driver erasure (POST /v1/drivers/:id/erase): when the driver's personal data
-- was anonymized. Null for every existing driver. No statement of this file
-- uses the audit value.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "erased_at" timestamp with time zone;
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'erased';
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
-- New audited entity: report schedules, and generated, downloaded and deleted reports.
DO $$ BEGIN
  CREATE TYPE "report_schedule_audit_action" AS ENUM ('created', 'updated', 'deleted', 'report_deleted', 'report_generated', 'report_downloaded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- A database that ran an earlier build of this file has the type without them.
ALTER TYPE "report_schedule_audit_action" ADD VALUE IF NOT EXISTS 'report_generated';
--> statement-breakpoint
ALTER TYPE "report_schedule_audit_action" ADD VALUE IF NOT EXISTS 'report_downloaded';
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
-- Who deactivated a driver token. A driver may reactivate only a token the
-- driver deactivated, never one an operator blocked. The one-time backfill
-- (while the column is new) takes the actor of the token's last deactivation
-- audit row (an API key counts as an operator), else 'operator', so an
-- earlier operator block stays a block.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'driver_tokens' AND column_name = 'deactivated_by'
  ) THEN
    ALTER TABLE "driver_tokens" ADD COLUMN "deactivated_by" varchar(10);
    UPDATE "driver_tokens" t
      SET "deactivated_by" = coalesce(
        (SELECT CASE WHEN a."actor"::text IN ('driver', 'system') THEN a."actor"::text
                     ELSE 'operator' END
          FROM "token_audit_log" a
          WHERE a."token_id" = t."id" AND a."action" = 'deactivated'
          ORDER BY a."id" DESC LIMIT 1),
        'operator')
      WHERE t."is_active" = false;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'driver_tokens_deactivated_by_check'
  ) THEN
    ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_deactivated_by_check"
      CHECK ("deactivated_by" IS NULL OR "deactivated_by" IN ('operator', 'driver', 'system'));
  END IF;
END $$;
--> statement-breakpoint
-- Prepaid cards never go on a station's local auth list (a station checks a
-- prepaid balance online). Lists that hold one are marked changed, so the
-- operator is prompted to push and the push drops the entry. A rerun finds
-- the same lists and moves their change time again, which changes nothing
-- else.
UPDATE "station_local_auth_versions" v
  SET "last_modified_at" = now(), "updated_at" = now()
  WHERE EXISTS (
    SELECT 1 FROM "station_local_auth_entries" e
    JOIN "driver_tokens" t ON t."id" = e."driver_token_id"
    WHERE e."station_id" = v."station_id" AND t."prepaid_balance_cents" IS NOT NULL
  );
--> statement-breakpoint
-- Token values that no longer exist (deleted or renamed driver tokens). The
-- OCPI eMSP Tokens sender serves them as valid = false, since OCPI cannot
-- delete a Token.
CREATE TABLE IF NOT EXISTS "driver_token_tombstones" (
  "id" serial PRIMARY KEY NOT NULL,
  "id_token" varchar(255) NOT NULL,
  "token_type" varchar(20) NOT NULL,
  "invalidated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_driver_token_tombstones_token" ON "driver_token_tombstones" ("id_token", "token_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_driver_token_tombstones_invalidated_at" ON "driver_token_tombstones" ("invalidated_at");
--> statement-breakpoint
-- Hourly: a driver token whose expiry passed gets a new updated_at, so OCPI
-- partners pulling Tokens changed since their last pull see it invalid, and
-- the change is pushed to them.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'driver-token-expiry', '5 * * * *', 'pending', NOW() + INTERVAL '1 hour'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'driver-token-expiry');
--> statement-breakpoint
-- Autocharge (charge by plugging in): a vehicle's VIN or EVCCID authorizes a
-- start as the vehicle's driver. Off by default, company-wide and per site
-- (null follows the setting). An operator value already set stays.
INSERT INTO settings (key, value) VALUES ('autocharge.enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Vehicle ids compare normalized: a VIN uppercase without spaces, an empty
-- VIN as none. A rerun finds every VIN normalized and writes nothing.
UPDATE "vehicles" SET "vin" = NULLIF(upper(btrim("vin")), ''), "updated_at" = now()
  WHERE "vin" IS NOT NULL AND "vin" IS DISTINCT FROM NULLIF(upper(btrim("vin")), '');
--> statement-breakpoint
-- Free vend off restores authorization: the config templates holding the
-- values the site's stations reported when free vend was turned on.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "free_vend_restore_template_id_21" text;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "free_vend_restore_template_id_16" text;
--> statement-breakpoint
-- Retired EVSEs and connectors (an operator takes hardware with history out
-- of service instead of deleting it). Nullable without a default: no rewrite.
ALTER TABLE "evses" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
--> statement-breakpoint
-- Automatic insights: a regeneration's model analysis read the regenerating
-- user's wrong-vote note on the insight it replaced (owner decision
-- 2026-10-14). A constant default needs no rewrite; every older insight read
-- no note, so false is right for them.
ALTER TABLE "ai_insights" ADD COLUMN IF NOT EXISTS "feedback_used" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "autocharge_enabled" boolean;
--> statement-breakpoint
ALTER TYPE "vehicle_audit_action" ADD VALUE IF NOT EXISTS 'autocharge_enabled';
--> statement-breakpoint
ALTER TYPE "vehicle_audit_action" ADD VALUE IF NOT EXISTS 'autocharge_disabled';
--> statement-breakpoint
ALTER TYPE "vehicle_audit_action" ADD VALUE IF NOT EXISTS 'autocharge_blocked';
--> statement-breakpoint
ALTER TYPE "vehicle_audit_action" ADD VALUE IF NOT EXISTS 'autocharge_unblocked';
--> statement-breakpoint
ALTER TYPE "vehicle_audit_action" ADD VALUE IF NOT EXISTS 'vehicle_id_claimed';
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "evccid" varchar(255);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "autocharge_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "autocharge_blocked_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_autocharge_id_check'
  ) THEN
    ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_autocharge_id_check"
      CHECK (NOT "autocharge_enabled" OR "evccid" IS NOT NULL OR "vin" IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicles_evccid" ON "vehicles" ("evccid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vehicles_vin" ON "vehicles" ("vin");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vehicles_autocharge_evccid" ON "vehicles" ("evccid")
  WHERE "autocharge_enabled" AND "evccid" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_vehicles_autocharge_vin" ON "vehicles" ("vin")
  WHERE "autocharge_enabled" AND "vin" IS NOT NULL;
--> statement-breakpoint
-- The vehicle id of each start, refused starts included. Nullable without a
-- default: no rewrite.
ALTER TABLE "authorize_attempts" ADD COLUMN IF NOT EXISTS "vehicle_id_value" varchar(255);
--> statement-breakpoint
ALTER TABLE "authorize_attempts" ADD COLUMN IF NOT EXISTS "vehicle_id_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "authorize_attempts" ADD COLUMN IF NOT EXISTS "matched_vehicle_id" text;
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
--> statement-breakpoint
-- The vehicle id the charger sent at the start and whether an Autocharge
-- vehicle authorized it. Nullable or a constant default: no rewrite.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "vehicle_id_value" varchar(255);
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "vehicle_id_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "vehicle_id_source" varchar(20);
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "autocharge" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Sessions keep the site they happened at: charging_sessions.site_id, stamped
-- from the station at insert by the code (sessionSiteIdSql), so a station moved to another site leaves its
-- revenue and session history at the old site. The backfill (every existing
-- session gets its station's current site, the best record there is) runs only
-- when this statement adds the column, so a rerun never overwrites a stamp.
-- It rewrites every session row once under the column's ACCESS EXCLUSIVE lock.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'charging_sessions' AND column_name = 'site_id'
  ) THEN
    ALTER TABLE "charging_sessions" ADD COLUMN "site_id" text;
    UPDATE "charging_sessions" cs SET "site_id" = st."site_id"
    FROM "charging_stations" st
    WHERE st."id" = cs."station_id" AND st."site_id" IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
-- NOT VALID: no scan here (the backfill only copied existing site ids);
-- VALIDATE CONSTRAINT is a v0.1.47 contract step.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'charging_sessions_site_id_sites_id_fk'
  ) THEN
    ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_site_id_sites_id_fk"
      FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- The code stamps site_id on every insert (sessionSiteIdSql in
-- @evtivity/database). An earlier build of this release stamped it with a
-- trigger; the schema keeps no triggers or functions, so a database that ran
-- that build drops both here.
DROP TRIGGER IF EXISTS charging_sessions_stamp_site ON "charging_sessions";
--> statement-breakpoint
DROP FUNCTION IF EXISTS charging_sessions_stamp_site();

--> statement-breakpoint
-- Dashboard snapshots: the billed sessions and their revenue (reservation fees
-- left out), cumulative through the snapshot date, so the revenue per session
-- of several sites matches the live figure. Null on rows written before.
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "billed_sessions" integer;
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD COLUMN IF NOT EXISTS "session_revenue_cents" bigint;

--> statement-breakpoint
-- beta.8 access
-- Operator access hardening: session versions (an access token carries the
-- version it was issued under), SSO accounts, sign-in and MFA backoff, the
-- TOTP replay guard and MFA challenge attempts.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_source" varchar(20) DEFAULT 'password' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "login_locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_failed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_last_step" bigint;
--> statement-breakpoint
ALTER TABLE "mfa_challenges" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- SSO auto-provisioning stored an empty password hash: those accounts are the
-- SSO accounts. One-time, while the check does not exist yet.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_auth_source_check') THEN
    UPDATE "users" SET "auth_source" = 'sso' WHERE "password_hash" = '';
    ALTER TABLE "users" ADD CONSTRAINT "users_auth_source_check"
      CHECK ("auth_source" IN ('password', 'sso'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'mfa_reset';
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'account_locked';
-- end beta.8 access
--> statement-breakpoint
-- beta.8 ocpi
-- lane B: how a partner's token started our CPO session (OCPI AuthMethod) and
-- the eMSP's authorization_reference, rendered in the Session and the CDR.
ALTER TABLE "ocpi_roaming_sessions" ADD COLUMN IF NOT EXISTS "auth_method" varchar(20);
--> statement-breakpoint
ALTER TABLE "ocpi_roaming_sessions" ADD COLUMN IF NOT EXISTS "authorization_reference" varchar(36);
--> statement-breakpoint
-- lane B: commands partners send us as CPO, kept so the CommandResult (or its
-- TIMEOUT) survives an OCPI restart and a START_SESSION links its session to
-- the partner that sent it. A new, empty table: plain indexes.
CREATE TABLE IF NOT EXISTS "ocpi_commands" (
  "id" text PRIMARY KEY NOT NULL,
  "partner_id" text NOT NULL,
  "command_type" varchar(30) NOT NULL,
  "response_url" text NOT NULL,
  "station_id" text,
  "token_uid" varchar(36),
  "token_type" varchar(20),
  "token_data" jsonb,
  "remote_start_id" integer,
  "authorization_reference" varchar(36),
  "charging_session_id" text,
  "result" varchar(30),
  "result_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ocpi_commands" ADD CONSTRAINT "ocpi_commands_partner_id_ocpi_partners_id_fk"
    FOREIGN KEY ("partner_id") REFERENCES "ocpi_partners"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ocpi_commands_station_token" ON "ocpi_commands" ("station_id", "token_uid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ocpi_commands_pending" ON "ocpi_commands" ("expires_at") WHERE result_sent_at IS NULL;
--> statement-breakpoint
-- lane A: credentials token kind. A registration token (CREDENTIALS_TOKEN_A)
-- reaches only versions, version details and credentials (OCPI 2.3.0 4.1).
-- The backfill runs only when this statement adds the column: issued tokens
-- of a partner that never completed the handshake, and unbound ones, are
-- registration tokens.
DO $$ BEGIN
  CREATE TYPE "public"."ocpi_token_kind" AS ENUM('registration', 'credentials');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ocpi_credentials_tokens' AND column_name = 'kind'
  ) THEN
    ALTER TABLE "ocpi_credentials_tokens"
      ADD COLUMN "kind" "ocpi_token_kind" NOT NULL DEFAULT 'credentials';
    UPDATE "ocpi_credentials_tokens" t SET "kind" = 'registration'
    WHERE t."direction" = 'issued'
      AND (
        t."partner_id" IS NULL
        OR EXISTS (
          SELECT 1 FROM "ocpi_partners" p WHERE p."id" = t."partner_id" AND p."status" = 'pending'
        )
      );
  END IF;
END $$;
--> statement-breakpoint
-- lane A: a token bound to no partner could register as any country code and
-- party id (the seed shipped two as public constants). Every issued token is
-- now bound to its partner, so the unbound ones are retired.
UPDATE "ocpi_credentials_tokens" SET "is_active" = false
WHERE "partner_id" IS NULL AND "direction" = 'issued' AND "is_active" = true;
--> statement-breakpoint
-- lane A: accept credentials tokens that are not Base64 encoded from this
-- partner (OCPI 2.1.1 and 2.2 peers, 2.3.0 4.1 note). Off by default.
ALTER TABLE "ocpi_partners" ADD COLUMN IF NOT EXISTS "allow_raw_token" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- lane A: audit rows written before stored the encrypted registration token
-- ciphertext of the partner. Rewrites only rows still holding a value.
UPDATE "ocpi_partner_audit_log"
SET "before" = "before" || '{"partnerRegistrationTokenEnc": "<redacted>"}'::jsonb
WHERE jsonb_typeof("before") = 'object'
  AND jsonb_typeof("before"->'partnerRegistrationTokenEnc') = 'string'
  AND "before"->>'partnerRegistrationTokenEnc' <> '<redacted>';
--> statement-breakpoint
UPDATE "ocpi_partner_audit_log"
SET "after" = "after" || '{"partnerRegistrationTokenEnc": "<redacted>"}'::jsonb
WHERE jsonb_typeof("after") = 'object'
  AND jsonb_typeof("after"->'partnerRegistrationTokenEnc') = 'string'
  AND "after"->>'partnerRegistrationTokenEnc' <> '<redacted>';
--> statement-breakpoint
-- lane D: session audit actions of the operator CDR reissue and push retry.
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'cdr_reissued';
--> statement-breakpoint
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'cdr_push_retried';
--> statement-breakpoint
-- lane D: CDR reissue. A CDR an operator credited and reissued keeps its row
-- (it was sent and stays the partner's record) with superseded_at set; the
-- reissued CDR is the session's live CDR. One live non-credit CDR per session
-- (uq_ocpi_cdrs_session_live, the only guard against two concurrent issues
-- besides the row lock). ocpi_cdrs is small (one row per roaming CDR), so the
-- index is built here, not CONCURRENTLY.
ALTER TABLE "ocpi_cdrs" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;
--> statement-breakpoint
-- Guarded one-time dedup, only while the index is missing: a session with more
-- than one live non-credit CDR keeps its earliest one live; the others are
-- marked superseded (never deleted: a partner may hold them).
DO $$
BEGIN
  IF to_regclass('uq_ocpi_cdrs_session_live') IS NULL THEN
    UPDATE "ocpi_cdrs" c
    SET "superseded_at" = now()
    WHERE c."charging_session_id" IS NOT NULL
      AND c."is_credit" = false
      AND c."superseded_at" IS NULL
      AND EXISTS (
        SELECT 1 FROM "ocpi_cdrs" k
        WHERE k."charging_session_id" = c."charging_session_id"
          AND k."is_credit" = false
          AND k."superseded_at" IS NULL
          AND (k."created_at", k."id") < (c."created_at", c."id")
      );
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ocpi_cdrs_session_live"
  ON "ocpi_cdrs" ("charging_session_id")
  WHERE "charging_session_id" IS NOT NULL AND "is_credit" = false AND "superseded_at" IS NULL;
-- end beta.8 ocpi
--> statement-breakpoint
-- beta.9 hardening
-- Notifications hardening. Idempotent.
--
-- 1. Driver Events switches exist only for driver notification types. Before this
--    release PUT /v1/driver-event-settings accepted any event type, and both
--    dispatchers honored a disabled row, so an operator could silence a system
--    notice (operator password reset, support case notices to operators, fleet
--    invoices) through it. The API now refuses such a row and dispatch ignores
--    one; this deletes the stray rows (also the stale 'connector.Available' seed).
--    The list is DRIVER_EVENT_TYPES of @evtivity/lib notification-events.ts at
--    this release.
DELETE FROM driver_event_settings
WHERE event_type NOT IN (
  'session.Started',
  'session.AutochargeStarted',
  'session.Updated',
  'session.Completed',
  'session.Faulted',
  'session.PaymentReceived',
  'session.IdlingStarted',
  'session.Receipt',
  'driver.Welcome',
  'driver.ForgotPassword',
  'driver.PasswordChanged',
  'driver.AccountVerification',
  'driver.MfaDisabled',
  'driver.PortalInvite',
  'driver.RegistrationAttempt',
  'payment.Complete',
  'payment.Refunded',
  'payment.FeeRefunded',
  'payment.PreAuthFailed',
  'payment.CaptureFailed',
  'payment.MissingPaymentMethod',
  'payment.AccountCreditLimit',
  'reservation.Created',
  'reservation.Cancelled',
  'reservation.CancelledForMaintenance',
  'reservation.Expiring',
  'reservation.Expired',
  'reservation.StationFaulted',
  'reservation.TakenByOther',
  'invoice.Sent',
  'invoice.CreditNote',
  'invoice.MemberInvoice',
  'invoice.MemberCreditNote',
  'invoice.MemberOverdue',
  'supportCase.Created',
  'supportCase.OperatorReply',
  'supportCase.Resolved',
  'supportCase.AiAnswered',
  'mfa.VerificationCode',
  'token.Added',
  'token.Removed',
  'token.Deactivated',
  'token.Reactivated',
  'maintenance.SessionStopped',
  'watch.StationAvailable',
  'prepaid.LowCredit',
  'prepaid.CreditExhausted',
  'fleet.AccountBillingChanged'
);
--> statement-breakpoint
-- 2. The required driver types are always on (REQUIRED_DRIVER_EVENT_TYPES), now
--    including the security notices driver.PasswordChanged and driver.MfaDisabled.
--    Dispatch already ignores a stored disabled row for them; re-enable the rows so
--    the CSMS Driver Events tab and the API show the real state.
UPDATE driver_event_settings
SET is_enabled = true, updated_at = now()
WHERE is_enabled = false
  AND event_type IN (
    'driver.ForgotPassword',
    'driver.AccountVerification',
    'driver.PortalInvite',
    'driver.RegistrationAttempt',
    'driver.PasswordChanged',
    'driver.MfaDisabled',
    'mfa.VerificationCode',
    'invoice.MemberInvoice',
    'invoice.MemberCreditNote',
    'invoice.MemberOverdue',
    'session.AutochargeStarted'
  );
--> statement-breakpoint
-- 3. The '$admin' OCPP event setting recipient was never resolved: dispatch sent to
--    the literal address "$admin", which always failed. The API now refuses it.
--    Clear stored ones so the setting shows no recipient (an empty recipient sends
--    nothing) instead of a value the API would refuse on the next save.
UPDATE ocpp_event_settings
SET recipient = '', updated_at = now()
WHERE recipient = '$admin';
-- end beta.9 hardening

-- beta.9 more
-- Event alert recipients, guest language, circuit voltage, sub-panel phases and guest
-- start limits. Idempotent.
--
-- 1. Event alert rules: the '$admin' recipient default was never resolved to
--    an address (no dispatch reads it as a placeholder). The API now refuses
--    placeholders; the column defaults to empty and stored ones are cleared.
ALTER TABLE event_alert_rules ALTER COLUMN notify_recipient SET DEFAULT '';
--> statement-breakpoint
UPDATE event_alert_rules
SET notify_recipient = '', updated_at = now()
WHERE notify_recipient = '$admin';
--> statement-breakpoint
-- 2. -- Guest notices in the guest's language: the UI language sent at checkout
-- (en, de, es, ko, zh, zh-TW). Null keeps the company language.
ALTER TABLE "guest_sessions" ADD COLUMN IF NOT EXISTS "language" varchar(10);
--> statement-breakpoint
-- 3. Circuit voltage (load management): a circuit of a single-phase panel can run
-- at a lower voltage than its panel, such as a 120 V branch of a 240 V
-- split-phase panel. Null keeps the panel voltage, the behavior before.
ALTER TABLE "circuits" ADD COLUMN IF NOT EXISTS "voltage_v" integer;
--> statement-breakpoint
-- Only the panel voltages the CSMS offers.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'circuits_voltage_v_check') THEN
    ALTER TABLE "circuits" ADD CONSTRAINT "circuits_voltage_v_check"
      CHECK ("voltage_v" IS NULL OR "voltage_v" IN (120, 208, 220, 230, 240, 277, 480));
  END IF;
END $$;
--> statement-breakpoint
-- 4. Sub-panel phase connections (load management): the phases of a three-phase
-- parent panel that feed a single-phase sub-panel. Null keeps the conservative
-- rule before: the sub-panel's load counts in full on every parent phase.
ALTER TABLE "panels" ADD COLUMN IF NOT EXISTS "phase_connections" varchar(10);
--> statement-breakpoint
-- One phase (line to neutral) or two (line to line), never three.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'panels_phase_connections_check') THEN
    ALTER TABLE "panels" ADD CONSTRAINT "panels_phase_connections_check"
      CHECK ("phase_connections" IS NULL OR "phase_connections" IN ('L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3'));
  END IF;
END $$;
--> statement-breakpoint
-- 5. Guest start limits per client IP and hour (0 means no limit), applied
--    only when the real client IP is known.
INSERT INTO settings (key, value) VALUES ('guest.startsPerIpPerHour', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO settings (key, value) VALUES ('guest.declinesPerIpPerHour', '5'::jsonb)
ON CONFLICT (key) DO NOTHING;
-- end beta.9 more
--> statement-breakpoint
-- 6. Hours a station stays offline before a stuck session there gets the CSMS
--    end action (1 to 720); before that its AI insight advises restoring the
--    connection. An install that ran this file before reads the default (24).
INSERT INTO settings (key, value) VALUES ('aiWorkers.stuckSessions.offlineEndAfterHours', '24'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- 7. Days after which a one-off event insight still open (a failed session,
--    a reservation problem, a tariff anomaly, an authorization refusal with no
--    clearing condition) is closed expired (1 to 365). An install that ran
--    this file before reads the default (7).
INSERT INTO settings (key, value) VALUES ('aiInsights.expireAfterDays', '7'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- 8. Per-station AI insight suppression: while ai_insights_suppressed_at is
--    set and ai_insights_suppressed_until is null or ahead, the insight scan
--    and the AI workers create nothing for the station.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_by" text;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_reason" varchar(500);
-- end beta.10
--> statement-breakpoint
-- 9. Conformance test stations (OCTT): the runners mark every station they
--    create, and operator lists, counts, aggregates and targets leave them
--    out. The backfill marks stations a run created before the column existed
--    and only writes rows still unmarked, so a rerun changes nothing.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "is_conformance" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "charging_stations" SET "is_conformance" = true
WHERE "station_id" LIKE 'OCTT-%' AND NOT "is_conformance";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_charging_stations_is_conformance" ON "charging_stations" ("id") WHERE "is_conformance";
--> statement-breakpoint
-- Cron that removes what crashed or killed conformance runs left: idle test
-- stations and the test driver (handlers/conformance-station-sweep.ts),
-- every 10 minutes.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'conformance-station-sweep', '*/10 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'conformance-station-sweep');
-- end conformance stations
--> statement-breakpoint
-- 10. Per-site AI insight suppression: while sites.ai_insights_suppressed_at
--     is set and ai_insights_suppressed_until is null or ahead, the insight
--     scan and the AI workers create nothing for the site or its stations.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_by" text;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "ai_insights_suppressed_reason" varchar(500);
-- end site AI insight suppression
--> statement-breakpoint
-- 11. AI provider quota alerts: one row per provider whose account answered
--     out of credit or over quota (cleared_at null while active). Kept after
--     it clears, so the daily notification claim (notified_on) holds.
CREATE TABLE IF NOT EXISTS "ai_provider_alerts" (
  "provider" varchar(20) PRIMARY KEY NOT NULL,
  "since_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "cleared_at" timestamp with time zone,
  "last_probe_at" timestamp with time zone,
  "notified_on" varchar(10),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- end AI provider quota alerts
