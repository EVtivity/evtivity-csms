-- AI conversation audit entity, and via_ai on every audit table: when an AI
-- assistant tool call (confirmed by the user for a write) makes a change, the
-- audit row the route writes records { conversationId, toolCallId }.
-- Idempotent.
DO $$ BEGIN
  CREATE TYPE "ai_conversation_audit_action" AS ENUM ('created', 'renamed', 'deleted', 'tool_called', 'action_confirmed', 'action_rejected', 'attachment_added');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_conversation_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "ai_conversation_id" text,
  "ai_conversation_id_snapshot" text NOT NULL,
  "action" "ai_conversation_audit_action" NOT NULL,
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
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_conversation_audit_conversation_id" ON "ai_conversation_audit_log" ("ai_conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_conversation_audit_created_at" ON "ai_conversation_audit_log" ("created_at");--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'site_audit_log', 'station_audit_log', 'driver_audit_log', 'fleet_audit_log',
    'user_audit_log', 'vehicle_audit_log', 'support_case_audit_log', 'ocpi_partner_audit_log',
    'certificate_audit_log', 'role_audit_log', 'api_key_audit_log', 'setting_audit_log',
    'smart_charging_template_audit_log', 'config_template_audit_log',
    'firmware_campaign_audit_log', 'station_image_audit_log', 'local_auth_list_audit_log',
    'token_audit_log', 'reservation_audit_log', 'pricing_group_audit_log', 'tariff_audit_log',
    'holiday_audit_log', 'pricing_assignment_audit_log', 'maintenance_event_audit_log',
    'session_audit_log', 'invoice_audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "via_ai" jsonb', t);
  END LOOP;
END $$;
