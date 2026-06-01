-- Maintenance mode: per-site immediate or scheduled maintenance windows. The
-- worker activates events at planned_start_at and ends them at planned_end_at.
-- See `.claude/rules/features/maintenance-mode.md` for the full design.

CREATE TYPE "public"."maintenance_event_type" AS ENUM('immediate', 'one_off');--> statement-breakpoint
CREATE TYPE "public"."maintenance_event_status" AS ENUM('scheduled', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."maintenance_session_policy" AS ENUM('ignore', 'stop_graceful');--> statement-breakpoint
CREATE TYPE "public"."maintenance_event_audit_action" AS ENUM('created', 'started', 'ended', 'cancelled', 'sessions_stopped', 'reservations_cancelled');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "maintenance_events" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "event_type" "maintenance_event_type" NOT NULL,
  "status" "maintenance_event_status" DEFAULT 'scheduled' NOT NULL,
  "planned_start_at" timestamp with time zone NOT NULL,
  "planned_end_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "affected_station_ids" text[],
  "active_session_policy" "maintenance_session_policy" DEFAULT 'ignore' NOT NULL,
  "custom_message" text,
  "reason" text,
  "reservations_cancelled_count" integer DEFAULT 0 NOT NULL,
  "sessions_stopped_count" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_maintenance_events_site_status" ON "maintenance_events" ("site_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maintenance_events_planned_start_at" ON "maintenance_events" ("planned_start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maintenance_events_planned_end_at" ON "maintenance_events" ("planned_end_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "maintenance_event_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "maintenance_event_id" text,
  "maintenance_event_id_snapshot" text NOT NULL,
  "action" "maintenance_event_audit_action" NOT NULL,
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

CREATE INDEX IF NOT EXISTS "idx_maintenance_event_audit_event_id" ON "maintenance_event_audit_log" ("maintenance_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maintenance_event_audit_created_at" ON "maintenance_event_audit_log" ("created_at");
