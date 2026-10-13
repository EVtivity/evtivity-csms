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
