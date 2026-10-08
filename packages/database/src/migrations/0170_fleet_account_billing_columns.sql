-- Fleet account billing (charge on account, billed to the fleet). A fleet
-- with account_billing_enabled bills its members' sessions to the fleet; a
-- member with account_billing_opt_out pays by card. Each driver session
-- records once, at its start, how it is paid: billing_mode 'card' or
-- 'account', and for 'account' the fleet it is billed to (billing_fleet_id,
-- ON DELETE RESTRICT: a fleet with account sessions is never deleted). The
-- checks and the foreign key are added NOT VALID and validated by 0171.
-- Metadata only, idempotent.

ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "account_billing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_drivers" ADD COLUMN IF NOT EXISTS "account_billing_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "billing_mode" varchar(8);--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "billing_fleet_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_billing_mode_check"
    CHECK ("billing_mode" IS NULL OR "billing_mode" IN ('card', 'account')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_billing_fleet_check"
    CHECK (coalesce("billing_mode" = 'account', false) = ("billing_fleet_id" IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_billing_fleet_id_fleets_id_fk"
    FOREIGN KEY ("billing_fleet_id") REFERENCES "fleets"("id") ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
