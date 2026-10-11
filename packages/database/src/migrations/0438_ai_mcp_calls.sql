-- MCP tool call log (v0.1.44 item 3). One row per tools/call on POST /v1/mcp.
-- A 'delivered' row is unique per proposal: it returns the result of an
-- approved MCP proposal to the client once. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_mcp_calls" (
  "id" text PRIMARY KEY NOT NULL,
  "api_key_id" integer,
  "user_id" text,
  "client_name" varchar(100),
  "client_version" varchar(50),
  "protocol_version" varchar(20),
  "tool_name" varchar(200) NOT NULL,
  "operation_id" varchar(200),
  "method" varchar(10),
  "path" text,
  "args" jsonb,
  "status" varchar(20) NOT NULL,
  "http_status" integer,
  "error_code" varchar(60),
  "latency_ms" integer,
  "redaction_counts" jsonb,
  "proposal_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_mcp_calls_status_check" CHECK ("status" IN ('ok', 'error', 'refused', 'proposed', 'pending', 'delivered', 'decided'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_mcp_calls" ADD CONSTRAINT "ai_mcp_calls_api_key_id_refresh_tokens_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "refresh_tokens"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_mcp_calls" ADD CONSTRAINT "ai_mcp_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_mcp_calls" ADD CONSTRAINT "ai_mcp_calls_proposal_id_ai_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "ai_proposals"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_mcp_calls_key_created" ON "ai_mcp_calls" ("api_key_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_mcp_calls_created" ON "ai_mcp_calls" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_mcp_calls_proposal" ON "ai_mcp_calls" ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_mcp_calls_delivered_proposal" ON "ai_mcp_calls" ("proposal_id") WHERE "status" = 'delivered';
