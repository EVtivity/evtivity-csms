-- AI proposals and background worker runs (v0.1.44 item 4). A proposal is a
-- write a background worker or an MCP client asks for; it runs only after an
-- operator confirms it in the AI Inbox. Statuses leave 'pending' once and
-- never move again. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_worker_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "job" varchar(40) NOT NULL,
  "site_id" text,
  "scope_key" varchar(40) NOT NULL,
  "period" varchar(32) NOT NULL,
  "status" varchar(20) DEFAULT 'running' NOT NULL,
  "proposals_count" integer DEFAULT 0 NOT NULL,
  "findings_count" integer DEFAULT 0 NOT NULL,
  "insight_id" text,
  "output" jsonb,
  "error" varchar(1000),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "uq_ai_worker_runs_job_scope_period" UNIQUE("job", "scope_key", "period"),
  CONSTRAINT "ai_worker_runs_status_check" CHECK ("status" IN ('running', 'completed', 'failed', 'skipped', 'budget_skipped'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_worker_runs" ADD CONSTRAINT "ai_worker_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_worker_runs_started" ON "ai_worker_runs" ("started_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_proposals" (
  "id" text PRIMARY KEY NOT NULL,
  "source" varchar(10) NOT NULL,
  "job" varchar(40),
  "insight_id" text,
  "worker_run_id" integer,
  "requested_by_user_id" text,
  "api_key_id" integer,
  "site_id" text,
  "station_id" text,
  "session_id" text,
  "operation_id" varchar(200) NOT NULL,
  "method" varchar(10) NOT NULL,
  "path" text NOT NULL,
  "args" jsonb NOT NULL,
  "args_hash" varchar(64) NOT NULL,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rationale_text" text,
  "rationale_language" varchar(10),
  "precondition" jsonb,
  "dedup_key" varchar(200),
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "executed_at" timestamp with time zone,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_proposals_source_check" CHECK ("source" IN ('worker', 'mcp')),
  CONSTRAINT "ai_proposals_status_check" CHECK ("status" IN ('pending', 'executed', 'failed', 'rejected', 'expired', 'stale'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_worker_run_id_ai_worker_runs_id_fk" FOREIGN KEY ("worker_run_id") REFERENCES "ai_worker_runs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_api_key_id_refresh_tokens_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "refresh_tokens"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "charging_stations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_session_id_charging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "charging_sessions"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_proposals_status_site" ON "ai_proposals" ("status", "site_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_proposals_station" ON "ai_proposals" ("station_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_proposals_session" ON "ai_proposals" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_proposals_pending_expiry" ON "ai_proposals" ("expires_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_proposals_pending_dedup" ON "ai_proposals" ("dedup_key") WHERE "status" = 'pending' AND "dedup_key" IS NOT NULL;
