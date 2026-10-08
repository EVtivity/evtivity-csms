-- Fleet credit limit at session start (fleet account billing, slice S7). A
-- fleet may set a credit limit (cents of the company currency, null: none):
-- an account start is refused while the fleet's exposure (unbilled, invoiced
-- and unpaid, and running account sessions) is at or above it. The billing
-- contacts are warned at credit_limit_warning_percent (default 80). Each
-- notice is sent once per fleet, calendar month and kind: the claim row in
-- fleet_credit_limit_notices. The station screen message shown when the gate
-- stops a session at the limit, in the six display languages. Idempotent;
-- ON CONFLICT DO NOTHING keeps operator template edits.
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "credit_limit_cents" integer;--> statement-breakpoint
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "credit_limit_warning_percent" smallint DEFAULT 80 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fleets" ADD CONSTRAINT "fleets_credit_limit_cents_check"
    CHECK ("credit_limit_cents" IS NULL OR "credit_limit_cents" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fleets" ADD CONSTRAINT "fleets_credit_limit_warning_percent_check"
    CHECK ("credit_limit_warning_percent" BETWEEN 1 AND 99);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fleet_credit_limit_notices" (
  "fleet_id" text NOT NULL,
  "period_start" date NOT NULL,
  "kind" varchar(8) NOT NULL,
  "exposure_cents" integer NOT NULL,
  "limit_cents" integer NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fleet_credit_limit_notices_pkey" PRIMARY KEY ("fleet_id", "period_start", "kind"),
  CONSTRAINT "fleet_credit_limit_notices_kind_check" CHECK ("kind" IN ('warning', 'reached'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fleet_credit_limit_notices" ADD CONSTRAINT "fleet_credit_limit_notices_fleet_id_fleets_id_fk"
    FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
INSERT INTO "station_message_templates" ("state", "language", "body") VALUES
  ('account_credit_limit', 'en', E'Fleet credit limit reached.\nCharging stopped.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('account_credit_limit', 'de', E'Kreditlimit der Flotte erreicht.\nLaden beendet.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('account_credit_limit', 'es', E'Límite de crédito de la flota alcanzado.\nCarga detenida.\n{{#if supportPhone}}Soporte: {{supportPhone}}{{/if}}'),
  ('account_credit_limit', 'ko', E'차량대 신용 한도에 도달했습니다.\n충전이 중지되었습니다.\n{{#if supportPhone}}고객센터: {{supportPhone}}{{/if}}'),
  ('account_credit_limit', 'zh', E'车队信用额度已用完。\n充电已停止。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}'),
  ('account_credit_limit', 'zh-TW', E'車隊信用額度已用完。\n充電已停止。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}')
ON CONFLICT ("state", "language") DO NOTHING;
