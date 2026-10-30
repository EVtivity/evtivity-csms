-- v0.1.49 release migration. Idempotent: every statement can run again.
--
-- Site layout placement: a layout position counts only for the station's own
-- site, and a station without a position in a site that has a saved layout
-- gets the first free grid slot (5 columns, slot (c, r) at x = 20 + 200 c,
-- y = 20 + 140 r, a 160 by 120 px card that overlaps no other card), so new,
-- imported and moved stations no longer show stacked at the top left.
DELETE FROM station_layout_positions p
USING charging_stations s
WHERE s.id = p.station_id
  AND s.site_id IS DISTINCT FROM p.site_id;
--> statement-breakpoint
DO $$
DECLARE
  st record;
  slot_row integer;
  slot_col integer;
  px numeric;
  py numeric;
  placed_count integer := 0;
BEGIN
  FOR st IN
    SELECT s.id, s.site_id
    FROM charging_stations s
    WHERE s.site_id IS NOT NULL
      AND s.is_conformance = false
      AND NOT EXISTS (SELECT 1 FROM station_layout_positions p WHERE p.station_id = s.id)
      AND EXISTS (SELECT 1 FROM station_layout_positions p WHERE p.site_id = s.site_id)
    ORDER BY s.site_id, s.created_at, s.id
  LOOP
    slot_row := 0;
    <<search>>
    LOOP
      FOR slot_col IN 0..4 LOOP
        px := 20 + 200 * slot_col;
        py := 20 + 140 * slot_row;
        IF NOT EXISTS (
          SELECT 1 FROM station_layout_positions p
          WHERE p.site_id = st.site_id
            AND p.position_x < px + 160 AND px < p.position_x + 160
            AND p.position_y < py + 120 AND py < p.position_y + 120
        ) THEN
          INSERT INTO station_layout_positions (site_id, station_id, position_x, position_y)
          VALUES (st.site_id, st.id, px, py)
          ON CONFLICT (station_id) DO NOTHING;
          placed_count := placed_count + 1;
          EXIT search;
        END IF;
      END LOOP;
      slot_row := slot_row + 1;
    END LOOP;
  END LOOP;
  IF placed_count > 0 THEN
    RAISE NOTICE 'Placed % stations on a free layout slot of their site', placed_count;
  END IF;
END $$;
--> statement-breakpoint
-- 1NCE SIM provider: off by default, no credential. The client secret is
-- entered in the dashboard and stored encrypted; the client id may come from
-- Helm or CDK.
INSERT INTO "settings" ("key", "value") VALUES
  ('sim.1nce.enabled', 'false'::jsonb),
  ('sim.1nce.clientId', '""'::jsonb),
  ('sim.1nce.clientSecretEnc', '""'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- Payment terminals (features/payment-terminals.md). Permissions first: the
-- role defaults of permissions.ts, operators read and write terminals,
-- viewers read them. Admins are synced by sync-admin-permissions.ts after
-- every migrate. Granted once, before payment_terminal_transactions exists,
-- so a rerun never grants back a permission an admin removed.
DO $$ BEGIN
  IF to_regclass('public.payment_terminal_transactions') IS NULL THEN
    INSERT INTO user_permissions (user_id, permission)
    SELECT u.id, p.perm
    FROM users u
    JOIN roles r ON r.id = u.role_id
    CROSS JOIN (VALUES ('paymentTerminals:read'), ('paymentTerminals:write')) AS p(perm)
    WHERE r.name = 'operator'
    ON CONFLICT DO NOTHING;

    INSERT INTO user_permissions (user_id, permission)
    SELECT u.id, 'paymentTerminals:read'
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'viewer'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

--> statement-breakpoint
-- The terminal registry: the placeholder table of v0.1.48 gets the provider,
-- the pairing to one EVSE (null: station-wide), the operator status and the
-- device status. Nothing wrote the table before, so it should be empty; a
-- hand-inserted row can only be a hardware terminal (OCPP driven).
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "evse_id" text;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "provider" varchar(32);
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "integration_mode" varchar(16);
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "provider_device_id" varchar(128);
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "status" varchar(16) DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "online" boolean;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "status_fetched_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "offline_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "offline_alerted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "firmware_version" varchar(64);
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "ocpp_terminal_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "payment_terminals" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
UPDATE "payment_terminals" SET "provider" = 'ocpp' WHERE "provider" IS NULL;
--> statement-breakpoint
UPDATE "payment_terminals" SET "integration_mode" = 'hardware' WHERE "integration_mode" IS NULL;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ALTER COLUMN "provider" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_terminals" ALTER COLUMN "integration_mode" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminals" ADD CONSTRAINT "payment_terminals_evse_id_evses_id_fk"
    FOREIGN KEY ("evse_id") REFERENCES "public"."evses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminals" ADD CONSTRAINT "payment_terminals_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminals" ADD CONSTRAINT "payment_terminals_integration_mode_check"
    CHECK ("integration_mode" IN ('cloud', 'hardware'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminals" ADD CONSTRAINT "payment_terminals_status_check"
    CHECK ("status" IN ('active', 'inactive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminals" ADD CONSTRAINT "payment_terminals_evse_needs_station_check"
    CHECK ("evse_id" IS NULL OR "station_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_terminals_provider_device" ON "payment_terminals" USING btree ("provider", "provider_device_id") WHERE "provider_device_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_terminals_active_evse" ON "payment_terminals" USING btree ("evse_id") WHERE "evse_id" IS NOT NULL AND "status" = 'active';

--> statement-breakpoint
-- One card payment at a terminal. Amounts are 1 to 1,000,000 cents; nothing
-- is captured above the authorized amount (the third layer of that rule,
-- after the settlement cap and the adapter); only the last 4 digits and the
-- 6-digit BIN of a card are kept (PCI scope).
CREATE TABLE IF NOT EXISTS "payment_terminal_transactions" (
  "id" text PRIMARY KEY NOT NULL,
  "payment_terminal_id" text NOT NULL,
  "provider" varchar(32) NOT NULL,
  "provider_txn_ref" varchar(200),
  "site_id" text,
  "station_id" text,
  "evse_number" integer,
  "guest_session_id" integer,
  "session_id" text,
  "payment_record_id" integer,
  "state" varchar(20) DEFAULT 'requested' NOT NULL,
  "currency" varchar(3) NOT NULL,
  "requested_cents" integer NOT NULL,
  "authorized_cents" integer,
  "captured_cents" integer,
  "refunded_cents" integer DEFAULT 0 NOT NULL,
  "card_last4" varchar(4),
  "card_bin" varchar(6),
  "card_brand" varchar(30),
  "decline_code" varchar(200),
  "failure_reason" varchar(500),
  "receipt_url" varchar(500),
  "receipt_email" varchar(255),
  "pending_operation_ref" varchar(200),
  "pending_operation_at" timestamp with time zone,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "authorized_at" timestamp with time zone,
  "captured_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_terminal_txn_state_check" CHECK ("state" IN ('requested', 'presenting', 'authorized', 'declined', 'expired', 'capture_requested', 'captured', 'void_requested', 'voided', 'refund_pending', 'partially_refunded', 'refunded', 'failed')),
  CONSTRAINT "payment_terminal_txn_amounts_check" CHECK ("requested_cents" BETWEEN 1 AND 1000000
    AND ("authorized_cents" IS NULL OR "authorized_cents" BETWEEN 1 AND "requested_cents")
    AND ("captured_cents" IS NULL OR ("authorized_cents" IS NOT NULL AND "captured_cents" BETWEEN 0 AND "authorized_cents"))
    AND "refunded_cents" BETWEEN 0 AND COALESCE("captured_cents", 0)),
  CONSTRAINT "payment_terminal_txn_card_check" CHECK (("card_last4" IS NULL OR "card_last4" ~ '^[0-9]{4}$')
    AND ("card_bin" IS NULL OR "card_bin" ~ '^[0-9]{6}$'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminal_transactions" ADD CONSTRAINT "payment_terminal_transactions_payment_terminal_id_payment_terminals_id_fk"
    FOREIGN KEY ("payment_terminal_id") REFERENCES "public"."payment_terminals"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminal_transactions" ADD CONSTRAINT "payment_terminal_transactions_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminal_transactions" ADD CONSTRAINT "payment_terminal_transactions_station_id_charging_stations_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminal_transactions" ADD CONSTRAINT "payment_terminal_transactions_guest_session_id_guest_sessions_id_fk"
    FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminal_transactions" ADD CONSTRAINT "payment_terminal_transactions_session_id_charging_sessions_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminal_transactions" ADD CONSTRAINT "payment_terminal_transactions_payment_record_id_payment_records_id_fk"
    FOREIGN KEY ("payment_record_id") REFERENCES "public"."payment_records"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_terminal_txn_provider_ref" ON "payment_terminal_transactions" USING btree ("provider", "provider_txn_ref") WHERE "provider_txn_ref" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_terminal_txn_guest_session" ON "payment_terminal_transactions" USING btree ("guest_session_id") WHERE "guest_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminal_txn_terminal" ON "payment_terminal_transactions" USING btree ("payment_terminal_id", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminal_txn_session" ON "payment_terminal_transactions" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminal_txn_site" ON "payment_terminal_transactions" USING btree ("site_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminal_txn_open" ON "payment_terminal_transactions" USING btree ("state", "updated_at") WHERE "state" IN ('requested', 'presenting', 'authorized', 'capture_requested', 'void_requested', 'refund_pending');

--> statement-breakpoint
-- New audited entity: payment terminals.
DO $$ BEGIN
  CREATE TYPE "payment_terminal_audit_action" AS ENUM ('created', 'updated', 'paired', 'unpaired', 'deactivated', 'reactivated', 'deleted', 'sim_attached', 'sim_detached', 'status_synced', 'payment_started', 'payment_voided');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_terminal_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "payment_terminal_id" text,
  "payment_terminal_id_snapshot" text NOT NULL,
  "action" "payment_terminal_audit_action" NOT NULL,
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
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminal_audit_entity_id" ON "payment_terminal_audit_log" ("payment_terminal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminal_audit_created_at" ON "payment_terminal_audit_log" ("created_at");

--> statement-breakpoint
-- ID TECH terminal settings: off by default, sandbox, no credential. The API
-- key, secret and webhook secret are entered in the dashboard and stored
-- encrypted; the switch cannot be turned on outside development and test
-- until a live sandbox run verifies the assumed contract.
INSERT INTO "settings" ("key", "value") VALUES
  ('paymentTerminals.idtech.enabled', 'false'::jsonb),
  ('paymentTerminals.idtech.environment', '"sandbox"'::jsonb),
  ('paymentTerminals.idtech.merchantId', '""'::jsonb),
  ('paymentTerminals.idtech.apiKeyEnc', '""'::jsonb),
  ('paymentTerminals.idtech.apiSecretEnc', '""'::jsonb),
  ('paymentTerminals.idtech.webhookSecretEnc', '""'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- Payment terminal prompts on the station display (a VP7200 has no screen),
-- in the six display languages. ON CONFLICT DO NOTHING keeps operator edits.
INSERT INTO "station_message_templates" ("state", "language", "body") VALUES
  ('terminal_card', 'en', E'Pay by card\nPresent your card\non the payment reader\nHold: {{terminalAmount}}'),
  ('terminal_card', 'de', E'Mit Karte bezahlen\nKarte an das Lesegerät halten\nReservierung: {{terminalAmount}}'),
  ('terminal_card', 'es', E'Pago con tarjeta\nAcerque la tarjeta al lector\nRetención: {{terminalAmount}}'),
  ('terminal_card', 'ko', E'카드 결제\n결제 단말기에 카드를 대세요\n보류 금액: {{terminalAmount}}'),
  ('terminal_card', 'zh', E'刷卡支付\n请在读卡器上出示银行卡\n预授权：{{terminalAmount}}'),
  ('terminal_card', 'zh-TW', E'刷卡付款\n請在讀卡機上出示銀行卡\n預授權：{{terminalAmount}}'),
  ('terminal_result', 'en', E'{{#if paymentApproved}}Payment approved.\n{{#if plugInAnyConnector}}Plug in at any connector.{{else}}Charging starts now.{{/if}}{{else}}Payment not approved.\nNo charge was made.{{/if}}'),
  ('terminal_result', 'de', E'{{#if paymentApproved}}Zahlung genehmigt.\n{{#if plugInAnyConnector}}An einem beliebigen Anschluss einstecken.{{else}}Das Laden startet jetzt.{{/if}}{{else}}Zahlung nicht genehmigt.\nEs wurde nichts belastet.{{/if}}'),
  ('terminal_result', 'es', E'{{#if paymentApproved}}Pago aprobado.\n{{#if plugInAnyConnector}}Conecte en cualquier conector.{{else}}La carga comienza ahora.{{/if}}{{else}}Pago no aprobado.\nNo se realizó ningún cargo.{{/if}}'),
  ('terminal_result', 'ko', E'{{#if paymentApproved}}결제가 승인되었습니다.\n{{#if plugInAnyConnector}}아무 커넥터에나 연결하세요.{{else}}지금 충전을 시작합니다.{{/if}}{{else}}결제가 승인되지 않았습니다.\n청구된 금액이 없습니다.{{/if}}'),
  ('terminal_result', 'zh', E'{{#if paymentApproved}}支付已批准。\n{{#if plugInAnyConnector}}请插入任意充电枪。{{else}}现在开始充电。{{/if}}{{else}}支付未获批准。\n未产生任何费用。{{/if}}'),
  ('terminal_result', 'zh-TW', E'{{#if paymentApproved}}付款已核准。\n{{#if plugInAnyConnector}}請插入任一充電槍。{{else}}現在開始充電。{{/if}}{{else}}付款未獲核准。\n未產生任何費用。{{/if}}'),
  ('terminal_receipt', 'en', E'Paid {{terminalAmount}}\nReceipt: {{receiptUrl}}'),
  ('terminal_receipt', 'de', E'Bezahlt: {{terminalAmount}}\nBeleg: {{receiptUrl}}'),
  ('terminal_receipt', 'es', E'Pagado: {{terminalAmount}}\nRecibo: {{receiptUrl}}'),
  ('terminal_receipt', 'ko', E'결제 금액: {{terminalAmount}}\n영수증: {{receiptUrl}}'),
  ('terminal_receipt', 'zh', E'已支付：{{terminalAmount}}\n收据：{{receiptUrl}}'),
  ('terminal_receipt', 'zh-TW', E'已付款：{{terminalAmount}}\n收據：{{receiptUrl}}')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Payment terminal crons (features/payment-terminals.md): the reconciliation of
-- transactions left in an intermediate state and the device status poll with
-- the 15-minute offline alert, every 5 minutes each.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'payment-terminal-reconcile', '*/5 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'payment-terminal-reconcile');
--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'payment-terminal-status', '*/5 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'payment-terminal-status');

--> statement-breakpoint
-- A payment terminal SIM attachment keeps the site of the terminal when it was
-- attached; a site change of the terminal closes the attachment, so the SIM
-- site windows read the site of the whole window, never the current one.
ALTER TABLE "sim_attachments" ADD COLUMN IF NOT EXISTS "site_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- A terminal attachment written before the column holds the terminal's site.
UPDATE "sim_attachments" a SET "site_id" = pt."site_id"
  FROM "payment_terminals" pt
  WHERE a."payment_terminal_id" = pt."id" AND a."site_id" IS NULL AND pt."site_id" IS NOT NULL;

--> statement-breakpoint
-- Object storage provider (S3-compatible endpoints, v0.1.49): AWS S3 by
-- default, no endpoint. Written only through PUT /v1/settings/s3, which checks
-- the endpoint against the private hosts and takes a fresh proof to change the
-- provider or the endpoint.
INSERT INTO "settings" ("key", "value") VALUES
  ('s3.provider', '"s3"'::jsonb),
  ('s3.endpoint', '""'::jsonb),
  ('s3.forcePathStyle', 'false'::jsonb),
  ('s3.allowedPrivateHosts', '[]'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- Connector maximum current takes decimals (31.5 A), like the maximum power
-- (numeric already). Converted only while the column is still an integer, so a
-- rerun neither rewrites nor locks the table.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'connectors'
      AND column_name = 'max_current_amps' AND data_type = 'integer'
  ) THEN
    ALTER TABLE "connectors" ALTER COLUMN "max_current_amps" TYPE numeric
      USING "max_current_amps"::numeric;
  END IF;
END $$;

--> statement-breakpoint
-- Site layout settings (v0.1.49): the paved lot (spots per row, rows, spot
-- size, lane width, facing) and the transformers on the grass, validated by
-- @evtivity/lib/site-layout-schema. Null on every existing site: the default
-- lot of 2 rows of 10 spots, grown to hold the stations the site already has,
-- with one transformer. The CHECK is dropped and added again on a rerun.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "layout_settings" jsonb;
--> statement-breakpoint
ALTER TABLE "sites" DROP CONSTRAINT IF EXISTS "sites_layout_settings_check";
--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_layout_settings_check"
  CHECK ("layout_settings" IS NULL OR jsonb_typeof("layout_settings") = 'object');
