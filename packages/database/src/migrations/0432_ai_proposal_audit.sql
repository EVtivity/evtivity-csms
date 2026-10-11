-- AI proposal audit entity: created, confirmed, executed, failed, rejected,
-- expired and stale. Written only by the proposal service. Idempotent.
DO $$ BEGIN
  CREATE TYPE "ai_proposal_audit_action" AS ENUM ('created', 'confirmed', 'executed', 'failed', 'rejected', 'expired', 'stale');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_proposal_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "ai_proposal_id" text,
  "ai_proposal_id_snapshot" text NOT NULL,
  "action" "ai_proposal_audit_action" NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_ai_proposal_audit_proposal_id" ON "ai_proposal_audit_log" ("ai_proposal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_proposal_audit_created_at" ON "ai_proposal_audit_log" ("created_at");
