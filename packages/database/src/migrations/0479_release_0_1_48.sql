-- v0.1.48 release migration. One file per release: extended in place during the
-- release cycle, every statement idempotent.

-- Password policy and session lifetimes (discussion #38), edited in Settings >
-- Security. The defaults equal the rules and lifetimes the code used before.
-- ON CONFLICT DO NOTHING keeps an operator value.
INSERT INTO "settings" ("key", "value") VALUES
  ('security.password.minLength', '12'::jsonb),
  ('security.password.requireUppercase', 'true'::jsonb),
  ('security.password.requireLowercase', 'true'::jsonb),
  ('security.password.requireNumber', 'true'::jsonb),
  ('security.password.requireSymbol', 'false'::jsonb),
  ('security.session.operatorAccessMinutes', '60'::jsonb),
  ('security.session.operatorRefreshDays', '30'::jsonb),
  ('security.session.driverAccessMinutes', '60'::jsonb),
  ('security.session.driverRefreshDays', '30'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- Required MFA for operators (discussion #39): off by default, so nobody has to
-- enroll until an admin requires it in Settings > Security > MFA.
INSERT INTO "settings" ("key", "value") VALUES
  ('security.mfa.required', '"off"'::jsonb),
  ('security.mfa.requiredRoles', '[]'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- Driver session versions: a driver access token carries the version it was
-- issued under (`sv`), so a password reset or change, a sign-out or a
-- deactivation ends the access tokens issued before it. Existing tokens carry
-- no version and count as 0, the default, so the upgrade signs no one out.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;

--> statement-breakpoint
-- MFA recovery codes: ten single-use codes per account, stored as argon2id
-- hashes, for a user or a driver.
CREATE TABLE IF NOT EXISTS "mfa_recovery_codes" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text,
  "driver_id" text,
  "code_hash" varchar(255) NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mfa_recovery_codes_exactly_one_account" CHECK (("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL))
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_driver_id_drivers_id_fk"
    FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mfa_recovery_codes_user_id" ON "mfa_recovery_codes" USING btree ("user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mfa_recovery_codes_driver_id" ON "mfa_recovery_codes" USING btree ("driver_id");

--> statement-breakpoint
-- Audit actions of the recovery codes. No statement of this file uses them.
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'recovery_codes_generated';
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'recovery_codes_regenerated';
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'recovery_code_used';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'recovery_codes_generated';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'recovery_codes_regenerated';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'recovery_code_used';

--> statement-breakpoint
-- Driver TOTP replay guard: the last time step a portal sign-in or proof
-- accepted, as users.totp_last_step for operators. Null accepts the next code.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "totp_last_step" bigint;

--> statement-breakpoint
-- Passkeys and security keys (WebAuthn): on by default as a second factor;
-- passwordless sign-in with a passkey stays off until an admin allows it.
INSERT INTO "settings" ("key", "value") VALUES
  ('security.mfa.webauthnEnabled', 'true'::jsonb),
  ('security.mfa.passkeyLoginEnabled', 'false'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- WebAuthn credentials of an operator or a driver. The public key is the COSE
-- key the authenticator returned; the counter detects a cloned authenticator.
CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text,
  "driver_id" text,
  "credential_id" text NOT NULL,
  "public_key" bytea NOT NULL,
  "counter" bigint DEFAULT 0 NOT NULL,
  "transports" text[] DEFAULT '{}'::text[] NOT NULL,
  "device_type" varchar(20) NOT NULL,
  "backed_up" boolean DEFAULT false NOT NULL,
  "aaguid" varchar(36),
  "user_handle" text NOT NULL,
  "name" varchar(100) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id"),
  CONSTRAINT "webauthn_credentials_exactly_one_account" CHECK (("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL))
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_driver_id_drivers_id_fk"
    FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webauthn_credentials_user_id" ON "webauthn_credentials" USING btree ("user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webauthn_credentials_driver_id" ON "webauthn_credentials" USING btree ("driver_id");

--> statement-breakpoint
-- Audit actions of the WebAuthn credentials. No statement of this file uses them.
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'webauthn_credential_added';
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'webauthn_credential_renamed';
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'webauthn_credential_removed';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'webauthn_credential_added';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'webauthn_credential_renamed';
--> statement-breakpoint
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'webauthn_credential_removed';

--> statement-breakpoint
-- Driver sign-in backoff: failed portal sign-ins and MFA codes in a row, and the
-- time until which the next one is refused, as on users.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "failed_login_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "login_locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "mfa_failed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "mfa_locked_until" timestamp with time zone;

--> statement-breakpoint
-- Wrong factor proofs from a signed-in session count apart from sign-in, so a
-- stolen session cannot keep the owner's sign-in locked.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "proof_failed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "proof_locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "proof_failed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "proof_locked_until" timestamp with time zone;

--> statement-breakpoint
-- The client a driver refresh token was issued to ('mobile' for the app), so a
-- renewal keeps the access token's client claim. Mobile tokens before this
-- release are the ones bound to a device; the backfill runs only with the column.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'client'
  ) THEN
    ALTER TABLE "refresh_tokens" ADD COLUMN "client" varchar(16);
    UPDATE "refresh_tokens" SET "client" = 'mobile'
    WHERE "driver_id" IS NOT NULL AND "device_id" IS NOT NULL;
  END IF;
END $$;

--> statement-breakpoint
-- A code sent to a new phone number is bound to that number (its SHA-256), so
-- it confirms only the number it was sent to.
ALTER TABLE "mfa_challenges" ADD COLUMN IF NOT EXISTS "destination_hash" varchar(64);
--> statement-breakpoint
-- The per-number cap counts the codes sent to one number across accounts.
CREATE INDEX IF NOT EXISTS "idx_mfa_challenges_destination_hash" ON "mfa_challenges" ("destination_hash");
--> statement-breakpoint
-- What a code is for (sign_in, proof, setup): a code confirms only its own
-- purpose, and sign-in codes are capped apart from a signed-in session's codes.
-- Codes live 5 minutes, so earlier rows need no backfill beyond the default.
ALTER TABLE "mfa_challenges" ADD COLUMN IF NOT EXISTS "purpose" varchar(16) DEFAULT 'sign_in' NOT NULL;

--> statement-breakpoint
-- The audit action of a driver sign-in lock. No statement of this file uses it.
ALTER TYPE "driver_audit_action" ADD VALUE IF NOT EXISTS 'account_locked';

--> statement-breakpoint
-- Required MFA for drivers: off by default, so no driver has to enroll until an
-- admin requires it in Settings > Security > MFA.
INSERT INTO "settings" ("key", "value") VALUES
  ('security.mfa.requireDrivers', 'false'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- SIM providers (discussion #40): off by default, so nothing calls a provider
-- or reads a station until an admin turns it on in Settings > Integrations.
-- An empty low signal alert is off.
INSERT INTO "settings" ("key", "value") VALUES
  ('sim.hologram.enabled', 'false'::jsonb),
  ('sim.hologram.orgId', '""'::jsonb),
  ('sim.hologram.apiKeyEnc', '""'::jsonb),
  ('sim.sessions.retentionDays', '90'::jsonb),
  ('sim.sessions.fetchDays', '7'::jsonb),
  ('sim.stationSignal.enabled', 'false'::jsonb),
  ('sim.signal.alertBelowDbm', '""'::jsonb),
  ('sim.ocpp16.signalKeys', '[]'::jsonb),
  ('sim.signal.goodDbm', '-65'::jsonb),
  ('sim.signal.fairDbm', '-85'::jsonb)
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
-- A station's SIM at its provider (discussion #40), apart from
-- charging_stations so no station reply or audit snapshot changes. A row
-- without a provider holds an operator-entered ICCID or a cached lookup miss.
CREATE TABLE IF NOT EXISTS "station_sim_matches" (
  "station_id" text PRIMARY KEY NOT NULL,
  "provider" varchar(32),
  "provider_ref" varchar(128),
  "meta" jsonb,
  "entered_iccid" varchar(20),
  "matched_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "confirmed_by" text,
  "lookup_missed_at" timestamp with time zone,
  "lookup_miss_reason" varchar(32),
  "sessions_synced_at" timestamp with time zone,
  "last_record_id" varchar(64),
  "alerts_synced_at" timestamp with time zone,
  "open_session_began_at" timestamp with time zone,
  "last_status" jsonb,
  "status_fetched_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "station_sim_matches" ADD CONSTRAINT "station_sim_matches_station_id_charging_stations_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "station_sim_matches" ADD CONSTRAINT "station_sim_matches_confirmed_by_users_id_fk"
    FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
-- Who entered the ICCID and whether that person had access to every site
-- then: only such an entry confirms the match at the lookup.
ALTER TABLE "station_sim_matches" ADD COLUMN IF NOT EXISTS "entered_by" text;

--> statement-breakpoint
ALTER TABLE "station_sim_matches" ADD COLUMN IF NOT EXISTS "entered_with_all_sites" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "station_sim_matches" ADD CONSTRAINT "station_sim_matches_entered_by_users_id_fk"
    FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
-- One provider SIM has one confirmed station; unconfirmed matches never block another station.
DROP INDEX IF EXISTS "uq_station_sim_matches_provider_ref";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_station_sim_matches_confirmed_ref" ON "station_sim_matches" USING btree ("provider", "provider_ref") WHERE "confirmed_at" IS NOT NULL;

--> statement-breakpoint
-- Closed cellular data sessions and SIM alerts fetched by a person's Refresh
-- (never in the background), and the time ranges fetched. Deleted after
-- sim.sessions.retentionDays by the log-retention-prune job.
CREATE TABLE IF NOT EXISTS "sim_sessions" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "station_id" text NOT NULL,
  "provider" varchar(32) NOT NULL,
  "provider_sim_id" varchar(128) NOT NULL,
  "provider_session_id" varchar(64) NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "bytes" bigint,
  "network_name" varchar(128),
  "radio_access_technology" varchar(32),
  "cell_id" varchar(64),
  "apn" varchar(128),
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_sessions" ADD CONSTRAINT "sim_sessions_station_id_charging_stations_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sim_sessions_provider_session" ON "sim_sessions" USING btree ("provider", "provider_session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_sessions_station_started" ON "sim_sessions" USING btree ("station_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_sessions_started" ON "sim_sessions" USING btree ("started_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sim_alerts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "station_id" text NOT NULL,
  "provider" varchar(32) NOT NULL,
  "provider_alert_id" varchar(64) NOT NULL,
  "kind" varchar(32) NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_alerts" ADD CONSTRAINT "sim_alerts_station_id_charging_stations_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sim_alerts_provider_alert" ON "sim_alerts" USING btree ("provider", "provider_alert_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_alerts_station_received" ON "sim_alerts" USING btree ("station_id", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_alerts_received" ON "sim_alerts" USING btree ("received_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sim_fetch_coverage" (
  "id" serial PRIMARY KEY NOT NULL,
  "station_id" text NOT NULL,
  "provider" varchar(32) NOT NULL,
  "covered_from" timestamp with time zone NOT NULL,
  "covered_to" timestamp with time zone NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_fetch_coverage" ADD CONSTRAINT "sim_fetch_coverage_station_id_charging_stations_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_fetch_coverage_station_from" ON "sim_fetch_coverage" USING btree ("station_id", "covered_from");

--> statement-breakpoint
-- Station signal reads (discussion #40): the unit of a reported variable and
-- whether the station can monitor it, from NotifyReport variableCharacteristics.
-- Null until a station reports them.
ALTER TABLE "station_configurations" ADD COLUMN IF NOT EXISTS "unit" varchar(16);
--> statement-breakpoint
ALTER TABLE "station_configurations" ADD COLUMN IF NOT EXISTS "supports_monitoring" boolean;

--> statement-breakpoint
-- The component instance of a monitored variable (a DataLink modem), and who
-- set the monitor: an operator, or the low signal alert of the SIM settings.
-- Existing rules are the operator's.
ALTER TABLE "variable_monitoring_rules" ADD COLUMN IF NOT EXISTS "component_instance" varchar(50);
--> statement-breakpoint
ALTER TABLE "variable_monitoring_rules" ADD COLUMN IF NOT EXISTS "source" varchar(32) DEFAULT 'operator' NOT NULL;

--> statement-breakpoint
-- One low signal monitor per station and modem. An earlier build of this file
-- could store two under a race; the newest is kept, once, before the index exists.
DO $$
BEGIN
  IF to_regclass('public.uq_variable_monitoring_rules_low_signal') IS NULL THEN
    DELETE FROM "variable_monitoring_rules" r
    USING "variable_monitoring_rules" newer
    WHERE r.source = 'low_signal'
      AND newer.source = 'low_signal'
      AND r.station_id = newer.station_id
      AND COALESCE(r.component_instance, '') = COALESCE(newer.component_instance, '')
      AND r.id < newer.id;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_variable_monitoring_rules_low_signal" ON "variable_monitoring_rules" USING btree ("station_id", COALESCE(component_instance, '')) WHERE source = 'low_signal';

--> statement-breakpoint
-- The GetMonitoringReport request a low signal monitor waits for, while its
-- monitor id is read back from the station. Null otherwise.
ALTER TABLE "variable_monitoring_rules" ADD COLUMN IF NOT EXISTS "report_request_id" integer;

--> statement-breakpoint
-- Why a low signal monitor id is read back (timeout, duplicate), or `resent` for
-- the one send after a timeout read found no monitor. Null otherwise.
ALTER TABLE "variable_monitoring_rules" ADD COLUMN IF NOT EXISTS "report_reason" varchar(16);

--> statement-breakpoint
-- The SIM (the match's provider_ref) each fetched alert and coverage range
-- belongs to, so after a SIM swap the timeline, the offline causes and the SIM
-- status show only the current confirmed SIM. Sessions carry it already
-- (provider_sim_id). The feature is new in this release, so no backfill: a row
-- an earlier build of this file stored keeps a null ref and shows for no SIM.
ALTER TABLE "sim_alerts" ADD COLUMN IF NOT EXISTS "provider_ref" varchar(128);
--> statement-breakpoint
ALTER TABLE "sim_fetch_coverage" ADD COLUMN IF NOT EXISTS "provider_ref" varchar(128);
