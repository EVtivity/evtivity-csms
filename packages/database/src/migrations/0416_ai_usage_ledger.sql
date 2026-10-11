-- AI usage ledger: one row per model call on every AI surface, the single
-- source of the AI token budgets and usage reports. Provenance ids carry no
-- foreign key so rows outlive conversation retention; a deleted user or site
-- sets its id to null. Idempotent.

CREATE TABLE IF NOT EXISTS "ai_usage_ledger" (
  "id" bigserial PRIMARY KEY,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  "surface" varchar(30) NOT NULL,
  "user_id" text,
  "site_id" text,
  "conversation_id" text,
  "ai_message_id" text,
  "insight_id" text,
  "worker_run_id" text,
  "provider" varchar(20) NOT NULL,
  "model" varchar(200) NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "cached_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "reasoning_tokens" integer NOT NULL DEFAULT 0,
  "cost_micros" bigint,
  CONSTRAINT "ai_usage_ledger_surface_check"
    CHECK ("surface" IN ('chatbot', 'support', 'insight', 'insight_translation', 'worker')),
  CONSTRAINT "ai_usage_ledger_tokens_check"
    CHECK ("input_tokens" >= 0 AND "cached_read_tokens" >= 0 AND "cache_write_tokens" >= 0 AND "output_tokens" >= 0 AND "reasoning_tokens" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_ledger_occurred_at" ON "ai_usage_ledger" ("occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_ledger_site_occurred_at" ON "ai_usage_ledger" ("site_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_ledger_user_occurred_at" ON "ai_usage_ledger" ("user_id", "occurred_at");
