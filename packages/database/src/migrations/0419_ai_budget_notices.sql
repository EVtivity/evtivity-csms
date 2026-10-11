-- AI budget threshold notices: one row per scope (company or site), scope id
-- ('' for the company), calendar month and level (warn or exceeded). The row
-- is the claim that the notice was sent, so each crossing is announced once
-- across processes. Idempotent.

CREATE TABLE IF NOT EXISTS "ai_budget_notices" (
  "scope" varchar(10) NOT NULL,
  "scope_id" text NOT NULL,
  "period" varchar(7) NOT NULL,
  "level" varchar(10) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ai_budget_notices_pkey" PRIMARY KEY ("scope", "scope_id", "period", "level"),
  CONSTRAINT "ai_budget_notices_scope_check" CHECK ("scope" IN ('company', 'site')),
  CONSTRAINT "ai_budget_notices_level_check" CHECK ("level" IN ('warn', 'exceeded'))
);
