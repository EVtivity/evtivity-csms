-- Operator re-bill of a session the CSMS gave up ending (stopped reason
-- EndRequestFailed). rebill_status: 'in_progress' while a request holds the
-- claim (rebill_claimed_at is its lease), then 'billed' or 'manual' (manual
-- billing outside the platform). The partial index serves the Sessions list
-- filter of sessions waiting for manual billing. session_audit_log records the
-- operator action. Metadata only, idempotent.

ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "rebill_status" varchar(16);--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "rebill_claimed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_rebill_status_check"
    CHECK (rebill_status IS NULL OR rebill_status IN ('in_progress', 'billed', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_charging_sessions_rebill_manual" ON "charging_sessions" ("created_at") WHERE rebill_status = 'manual';--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "session_audit_action" AS ENUM ('rebilled', 'manual_billing');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" text,
  "session_id_snapshot" text NOT NULL,
  "action" "session_audit_action" NOT NULL,
  "actor" "audit_actor" NOT NULL,
  "actor_user_id" text,
  "actor_driver_id" text,
  "actor_api_key_id" text,
  "actor_label" varchar(100),
  "before" jsonb,
  "after" jsonb,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_audit_session_id" ON "session_audit_log" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_audit_created_at" ON "session_audit_log" ("created_at");
