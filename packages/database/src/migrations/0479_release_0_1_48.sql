-- v0.1.48 release migration. One file per release: extended in place during the
-- release cycle, every statement idempotent.

-- Session meter summary, read pass (the columns are added at the end of the
-- file). While charging_sessions has no peak_power_w, the summary of every
-- session is read from the meter_values rows still present into a temporary
-- table, before any ALTER TABLE of this file, so the long scan holds only read
-- locks. The projection's rules: power in W or no unit, kW times 1000, location
-- Outlet or none, per MeterValue (timestamp and context) the value without a
-- phase (the highest when there are several), else the sum of distinct lines
-- (L1, L2, L3 and their -N forms); a state of charge in Percent or no unit, 0 to
-- 100, the newest reading. Once the column exists this reads nothing.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'charging_sessions'
      AND column_name = 'peak_power_w'
  ) THEN
    CREATE TEMP TABLE IF NOT EXISTS mv_summary_backfill (
      session_id text PRIMARY KEY,
      peak_power_w numeric,
      last_soc_percent numeric,
      last_soc_at timestamp with time zone
    ) ON COMMIT DROP;

    INSERT INTO mv_summary_backfill (session_id, peak_power_w)
    WITH samples AS (
      SELECT mv.session_id, mv.timestamp, mv.context, mv.phase,
        CASE
          WHEN mv.phase IN ('L1', 'L1-N') THEN 'L1'
          WHEN mv.phase IN ('L2', 'L2-N') THEN 'L2'
          WHEN mv.phase IN ('L3', 'L3-N') THEN 'L3'
        END AS line,
        CASE
          WHEN mv.unit IS NULL OR mv.unit = 'W' THEN mv.value
          WHEN mv.unit = 'kW' THEN mv.value * 1000
        END AS w
      FROM "meter_values" mv
      WHERE mv.session_id IS NOT NULL
        AND mv.measurand = 'Power.Active.Import'
        AND COALESCE(mv.location, 'Outlet') = 'Outlet'
    ), readings AS (
      SELECT session_id,
        COALESCE(
          MAX(w) FILTER (WHERE phase IS NULL),
          CASE WHEN COUNT(line) > 0 AND COUNT(line) = COUNT(DISTINCT line)
            THEN SUM(w) FILTER (WHERE line IS NOT NULL) END
        ) AS w
      FROM samples
      WHERE w IS NOT NULL
      GROUP BY session_id, timestamp, context
    )
    SELECT session_id, MAX(w) FROM readings
    WHERE w IS NOT NULL
    GROUP BY session_id
    ON CONFLICT (session_id) DO NOTHING;

    INSERT INTO mv_summary_backfill (session_id, last_soc_percent, last_soc_at)
    SELECT DISTINCT ON (mv.session_id) mv.session_id, mv.value, LEAST(mv.timestamp, now())
    FROM "meter_values" mv
    WHERE mv.session_id IS NOT NULL
      AND mv.measurand = 'SoC'
      AND (mv.unit IS NULL OR mv.unit = 'Percent')
      AND mv.value BETWEEN 0 AND 100
    ORDER BY mv.session_id, mv.timestamp DESC, mv.id DESC
    ON CONFLICT (session_id) DO UPDATE
      SET last_soc_percent = EXCLUDED.last_soc_percent, last_soc_at = EXCLUDED.last_soc_at;
  END IF;
END $$;
--> statement-breakpoint
-- v0.1.48 security data passes. They run before every ALTER TABLE of this
-- file, so their scans and row locks finish before any ACCESS EXCLUSIVE lock is
-- taken; none of them needs a column this file adds.

-- Admins keep the permissions that now gate the payment provider settings and
-- the station commands (firmware, station configuration, certificates, smart
-- charging, reservations and sessions). sync-admin-permissions.ts grants every
-- catalog permission to admins after each migrate as well; this statement keeps
-- the grant in the migration for an install that runs the SQL alone.
-- Permissions are read from user_permissions on each request (no JWT claim), so
-- no session ends.
INSERT INTO "user_permissions" ("user_id", "permission")
SELECT u."id", p."permission"
FROM "users" u
JOIN "roles" r ON r."id" = u."role_id" AND r."name" = 'admin'
CROSS JOIN (VALUES
  ('settings.payment:read'), ('settings.payment:write'),
  ('settings.firmware:read'), ('settings.firmware:write'),
  ('settings.stationConfig:read'), ('settings.stationConfig:write'),
  ('certificates:read'), ('certificates:write'),
  ('smartCharging:read'), ('smartCharging:write'),
  ('reservations:read'), ('reservations:write'),
  ('sessions:read'), ('sessions:write')
) AS p("permission")
ON CONFLICT ("user_id", "permission") DO NOTHING;

--> statement-breakpoint
-- A pending security profile is always an upgrade. The OCPP connection check
-- tries a pending profile first and promotes it, so a lower or equal value
-- would let a station connect on a weaker profile and keep it. Such values are
-- cleared here; a constraint after the ALTER TABLE statements refuses them.
UPDATE "charging_stations" SET "pending_security_profile" = NULL
WHERE "pending_security_profile" IS NOT NULL
  AND "pending_security_profile" <= "security_profile";

--> statement-breakpoint
-- Setting audit rows stored the ciphertext of encrypted settings ({ key, value }
-- with a key ending in Enc). writeAudit now redacts it (redactAuditPayload);
-- this replaces what earlier releases stored. A cleared secret ('' or null)
-- holds nothing to hide and stays. A rerun changes nothing: a redacted value no
-- longer matches.
UPDATE "setting_audit_log"
SET "before" = jsonb_set("before", '{value}', '"<redacted>"'::jsonb)
WHERE jsonb_typeof("before") = 'object'
  AND ("before"->>'key' LIKE '%Enc' OR "before"->>'key' LIKE '%\_enc')
  AND "before" ? 'value'
  AND jsonb_typeof("before"->'value') <> 'null'
  AND "before"->'value' NOT IN ('""'::jsonb, '"<redacted>"'::jsonb);

--> statement-breakpoint
UPDATE "setting_audit_log"
SET "after" = jsonb_set("after", '{value}', '"<redacted>"'::jsonb)
WHERE jsonb_typeof("after") = 'object'
  AND ("after"->>'key' LIKE '%Enc' OR "after"->>'key' LIKE '%\_enc')
  AND "after" ? 'value'
  AND jsonb_typeof("after"->'value') <> 'null'
  AND "after"->'value' NOT IN ('""'::jsonb, '"<redacted>"'::jsonb);

--> statement-breakpoint
-- The audit, sign-in and security event history is kept forever (0) or 30 to
-- 3650 days: a shorter history would let an attacker age out the trace of an
-- account takeover. A stored value from 1 to 29 (written before the floor
-- existed) is raised to 30, with a NOTICE naming each key. Idempotent: a second
-- run finds nothing below 30.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT "key", "value" FROM "settings"
    WHERE "key" IN ('audit.retentionDays', 'logs.loginAudit.retentionDays', 'logs.securityEvents.retentionDays')
      AND jsonb_typeof("value") = 'number'
      AND ("value")::text::numeric > 0
      AND ("value")::text::numeric < 30
  LOOP
    UPDATE "settings" SET "value" = '30'::jsonb, "updated_at" = now() WHERE "key" = r."key";
    RAISE NOTICE 'Data retention: % raised from % to 30 days (the security history floor)', r."key", r."value";
  END LOOP;
END $$;

--> statement-breakpoint
-- Ending a driver's sessions now drops the driver's push tokens, so a lost or
-- sold phone stops getting the driver's pushes. Inactive drivers ended theirs
-- before this release and kept their tokens, so their devices still got pushes.
DELETE FROM "driver_push_tokens"
WHERE "driver_id" IN (SELECT "id" FROM "drivers" WHERE "is_active" = false);

--> statement-breakpoint
-- Cards stored before this release whose value, in any spelling (a VID:
-- prefix, separators, case), is the VIN or EVCCID of another driver's vehicle.
-- The token and vehicle services refuse new ones, and the vehicle wins over
-- such a card at Authorize; these are deactivated once here, stamped as turned
-- off by the system at the upgrade (revoked_at, revoked_reason,
-- deactivated_by), and the local auth lists that hold them are marked changed
-- so the operator pushes them again. No token audit row, driver notice or OCPI
-- push is written for them: SQL cannot reach those, and the NOTICE gives the
-- count. OCPI partners see the card as not valid at their next Tokens pull
-- (its last_updated moves). A rerun finds none, since it reads active cards
-- only. The key expression is the one of token-vehicle-id-sql.ts.
DO $$
DECLARE
  deactivated integer;
BEGIN
  WITH keyed AS (
    SELECT id, driver_id,
      CASE
        WHEN upper(btrim(regexp_replace(btrim(id_token), '^vid:', '', 'i')))
          ~ '^([0-9A-F]{12}|[0-9A-F]{2}(:[0-9A-F]{2}){5}|[0-9A-F]{2}(-[0-9A-F]{2}){5}|[0-9A-F]{4}([.][0-9A-F]{4}){2})$'
          THEN regexp_replace(upper(btrim(regexp_replace(btrim(id_token), '^vid:', '', 'i'))), '[:.-]', '', 'g')
        ELSE upper(btrim(regexp_replace(btrim(id_token), '^vid:', '', 'i')))
      END AS key
    FROM driver_tokens
    WHERE is_active = true AND token_type <> 'eMAID'
  ), colliding AS (
    SELECT k.id FROM keyed k
    JOIN vehicles v ON v.vin = k.key AND v.driver_id IS DISTINCT FROM k.driver_id
    UNION
    SELECT k.id FROM keyed k
    JOIN vehicles v ON v.evccid = k.key AND v.driver_id IS DISTINCT FROM k.driver_id
  ), off AS (
    UPDATE driver_tokens t
    SET is_active = false, revoked_at = now(), revoked_reason = 'vehicle_id_in_use',
        deactivated_by = 'system', updated_at = now()
    FROM colliding c
    WHERE t.id = c.id AND t.is_active = true
    RETURNING t.id
  ), lists AS (
    UPDATE station_local_auth_versions v SET last_modified_at = now()
    WHERE v.station_id IN (
      SELECT e.station_id FROM station_local_auth_entries e JOIN off ON e.driver_token_id = off.id
    )
    RETURNING v.station_id
  )
  SELECT count(*) INTO deactivated FROM off;
  IF deactivated > 0 THEN
    RAISE NOTICE '% active card(s) held another driver''s vehicle id and were deactivated; OCPI partners were not told (they see it at their next Tokens pull) and no token audit row was written', deactivated;
  END IF;
END $$;

--> statement-breakpoint
-- Driver cards stored before this release whose value has a vehicle id shape
-- (a VID: prefix, a MAC address in any separator form, the 17-character VIN
-- shape) and that match no other driver's vehicle stay active: a bare-MAC 1.6
-- station may rely on one for its owner, and a VID: idTag no longer matches a
-- card of another type. Read only: the count goes to a NOTICE.
DO $$
DECLARE
  shaped integer;
BEGIN
  SELECT count(*) INTO shaped
  FROM driver_tokens
  WHERE is_active = true
    AND driver_id IS NOT NULL
    AND token_type NOT IN ('VIN', 'EVCCID', 'MacAddress')
    AND (
      btrim(id_token) ~* '^vid:'
      OR upper(btrim(id_token)) ~ '^([0-9A-F]{12}|[0-9A-F]{2}(:[0-9A-F]{2}){5}|[0-9A-F]{2}(-[0-9A-F]{2}){5}|[0-9A-F]{4}([.][0-9A-F]{4}){2})$'
      OR upper(btrim(id_token)) ~ '^[A-HJ-NPR-Z0-9]{17}$'
    );
  IF shaped > 0 THEN
    RAISE NOTICE '% active driver card(s) hold a vehicle id shaped value; they stay active and match only their exact spelling', shaped;
  END IF;
END $$;
--> statement-breakpoint

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
-- SIM inventory permissions: the role defaults of permissions.ts. Operators
-- read and write SIMs, viewers read them. Admins are synced by
-- sync-admin-permissions.ts after every migrate. Granted once, before the sims
-- table exists, so a rerun of an edited build never grants back a permission
-- an admin removed.
DO $$ BEGIN
  IF to_regclass('public.sims') IS NULL THEN
    INSERT INTO user_permissions (user_id, permission)
    SELECT u.id, p.perm
    FROM users u
    JOIN roles r ON r.id = u.role_id
    CROSS JOIN (VALUES ('sims:read'), ('sims:write')) AS p(perm)
    WHERE r.name = 'operator'
    ON CONFLICT DO NOTHING;

    INSERT INTO user_permissions (user_id, permission)
    SELECT u.id, 'sims:read'
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'viewer'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

--> statement-breakpoint
-- SIM inventory (discussion #40): one row per physical SIM, keyed by its
-- normalized ICCID (trimmed, upper case, a trailing F removed), with the
-- provider lookup, the fetch state of the last Refresh and the CSMS status
-- (active or inactive, set by an operator, apart from the provider status).
CREATE TABLE IF NOT EXISTS "sims" (
  "id" text PRIMARY KEY NOT NULL,
  "iccid" varchar(20) NOT NULL,
  "imsi" varchar(15),
  "provider" varchar(32),
  "provider_ref" varchar(128),
  "provider_meta" jsonb,
  "lookup_missed_at" timestamp with time zone,
  "lookup_miss_reason" varchar(32),
  "label" varchar(100),
  "notes" text,
  "last_status" jsonb,
  "status_fetched_at" timestamp with time zone,
  "open_session_began_at" timestamp with time zone,
  "last_record_id" varchar(64),
  "sessions_synced_at" timestamp with time zone,
  "alerts_synced_at" timestamp with time zone,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "deactivated_at" timestamp with time zone,
  "deactivated_by" text,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);


--> statement-breakpoint
-- A database that ran an earlier build of this file has sims without a status.
ALTER TABLE "sims" ADD COLUMN IF NOT EXISTS "status" varchar(16) DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sims" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sims" ADD COLUMN IF NOT EXISTS "deactivated_by" text;
--> statement-breakpoint
-- The history floor: raised to the close time whenever an attachment of the
-- SIM closes or a station holding its attachment is deleted, never lowered. A
-- station shows only the SIM's rows after it. Null shows them all.
ALTER TABLE "sims" ADD COLUMN IF NOT EXISTS "history_floor_at" timestamp with time zone;
--> statement-breakpoint
-- An earlier build of this file kept the lookup time, which nothing read.
ALTER TABLE "sims" DROP COLUMN IF EXISTS "matched_at";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sims" ADD CONSTRAINT "sims_status_check" CHECK ("status" IN ('active', 'inactive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sims_iccid" ON "sims" USING btree ("iccid");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sims_provider_ref" ON "sims" USING btree ("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sims_created_at" ON "sims" USING btree ("created_at");

--> statement-breakpoint
-- Payment terminals (placeholder): the second target a SIM can be attached
-- to. Nothing writes it in this release. Site and station are SET NULL on
-- delete: a terminal outlives the record it was mounted at.
CREATE TABLE IF NOT EXISTS "payment_terminals" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text,
  "station_id" text,
  "label" varchar(100),
  "vendor" varchar(255),
  "model" varchar(255),
  "serial_number" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);



--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminals_site_id" ON "payment_terminals" USING btree ("site_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_terminals_station_id" ON "payment_terminals" USING btree ("station_id");

--> statement-breakpoint
-- Which station (or payment terminal) a SIM sits in, with the history kept:
-- exactly one target, at most one open attachment per SIM and per target.
CREATE TABLE IF NOT EXISTS "sim_attachments" (
  "id" serial PRIMARY KEY NOT NULL,
  "sim_id" text NOT NULL,
  "station_id" text,
  "payment_terminal_id" text,
  "source" varchar(16) NOT NULL,
  "attached_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attached_by" text,
  "attached_with_all_sites" boolean DEFAULT false NOT NULL,
  "confirmed_at" timestamp with time zone,
  "confirmed_by" text,
  "detached_at" timestamp with time zone,
  "detached_by" text,
  "detach_reason" varchar(32)
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_sim_id_sims_id_fk"
    FOREIGN KEY ("sim_id") REFERENCES "public"."sims"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_payment_terminal_id_payment_terminals_id_fk"
    FOREIGN KEY ("payment_terminal_id") REFERENCES "public"."payment_terminals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;




--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_one_target_check"
    CHECK (num_nonnulls("station_id", "payment_terminal_id") = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_source_check"
    CHECK ("source" IN ('reported', 'entered', 'attached', 'imported'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
-- Dropped and added again, so a database that ran an earlier build of this
-- file gets the reasons added since.
ALTER TABLE "sim_attachments" DROP CONSTRAINT IF EXISTS "sim_attachments_detach_reason_check";
--> statement-breakpoint
ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_detach_reason_check"
  CHECK ("detach_reason" IS NULL OR "detach_reason" IN ('detached', 'iccid_changed', 'replaced', 'displaced', 'deactivated'));

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sim_attachments_open_sim" ON "sim_attachments" USING btree ("sim_id") WHERE "detached_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sim_attachments_open_station" ON "sim_attachments" USING btree ("station_id") WHERE "detached_at" IS NULL AND "station_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sim_attachments_open_terminal" ON "sim_attachments" USING btree ("payment_terminal_id") WHERE "detached_at" IS NULL AND "payment_terminal_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_attachments_sim_attached" ON "sim_attachments" USING btree ("sim_id", "attached_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_attachments_station_attached" ON "sim_attachments" USING btree ("station_id", "attached_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_attachments_terminal_attached" ON "sim_attachments" USING btree ("payment_terminal_id", "attached_at" DESC);

--> statement-breakpoint
-- New audited entity: SIMs.
DO $$ BEGIN
  CREATE TYPE "sim_audit_action" AS ENUM ('created', 'updated', 'deleted', 'attached', 'detached', 'attachment_confirmed', 'network_reset', 'deactivated', 'reactivated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- A database that ran an earlier build of this file has the type without the
-- status actions. No statement of this file uses them.
ALTER TYPE "sim_audit_action" ADD VALUE IF NOT EXISTS 'deactivated';
--> statement-breakpoint
ALTER TYPE "sim_audit_action" ADD VALUE IF NOT EXISTS 'reactivated';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sim_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "sim_id" text,
  "sim_id_snapshot" text NOT NULL,
  "action" "sim_audit_action" NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_sim_audit_entity_id" ON "sim_audit_log" ("sim_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_audit_created_at" ON "sim_audit_log" ("created_at");

--> statement-breakpoint
-- Closed cellular data sessions and SIM alerts of a SIM, fetched by a person's
-- Refresh (never in the background), and the time ranges fetched. Deleted
-- after sim.sessions.retentionDays by the log-retention-prune job. A database
-- that ran the beta.3 build has them keyed by station; the steps below move
-- them to the SIM.
CREATE TABLE IF NOT EXISTS "sim_sessions" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "sim_id" text NOT NULL,
  "provider" varchar(32) NOT NULL,
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
CREATE TABLE IF NOT EXISTS "sim_alerts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "sim_id" text NOT NULL,
  "provider" varchar(32) NOT NULL,
  "provider_alert_id" varchar(64) NOT NULL,
  "kind" varchar(32) NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sim_fetch_coverage" (
  "id" serial PRIMARY KEY NOT NULL,
  "sim_id" text NOT NULL,
  "provider" varchar(32) NOT NULL,
  "covered_from" timestamp with time zone NOT NULL,
  "covered_to" timestamp with time zone NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Who wrote a station's ICCID: reported by the station at boot, or
-- entered by a person (with that person and whether they had access to every
-- site), so a Refresh never attaches an entered ICCID as station-reported.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "iccid_source" varchar(16) DEFAULT 'reported' NOT NULL;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "iccid_entered_by" text;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "iccid_entered_with_all_sites" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_stations" ADD CONSTRAINT "charging_stations_iccid_source_check"
    CHECK ("iccid_source" IN ('reported', 'entered'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_stations" ADD CONSTRAINT "charging_stations_iccid_entered_by_users_id_fk"
    FOREIGN KEY ("iccid_entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
-- One-time move of the beta.3 station SIM matches, only while that table
-- exists (it is dropped below). One SIM per provider SIM: the confirmed match
-- wins, else the newest. Its ICCID is the station's when that normalizes to 19
-- or 20 digits, else the entered one; the winning match becomes the SIM's open
-- attachment, with who entered and confirmed it kept. Two provider SIMs with one
-- ICCID: the first (confirmed, else newest) keeps it, the other is not moved.
-- Then the ICCIDs users entered without a provider SIM are kept: the SIM is
-- found or made by ICCID and attached as entered, confirmed only when an
-- all-site user entered it, unless the SIM is attached elsewhere already. A
-- cached lookup miss without an entered ICCID, or a match without a valid ICCID,
-- is not moved: the station keeps its ICCID, and a Refresh attaches it again.
DO $$
DECLARE
  provider_sims integer;
  sims_made integer;
  moved integer;
  entered_rows integer;
  entered_moved integer;
  total integer;
BEGIN
  IF to_regclass('public.station_sim_matches') IS NULL THEN
    RETURN;
  END IF;
  -- The first build of this file had no entered_by or entered_with_all_sites.
  ALTER TABLE "station_sim_matches" ADD COLUMN IF NOT EXISTS "entered_by" text;
  ALTER TABLE "station_sim_matches" ADD COLUMN IF NOT EXISTS "entered_with_all_sites" boolean DEFAULT false NOT NULL;

  DROP TABLE IF EXISTS sim_move;
  CREATE TEMP TABLE sim_move ON COMMIT DROP AS
  SELECT DISTINCT ON (m.provider, m.provider_ref)
    m.station_id, m.provider, m.provider_ref, m.meta, m.entered_by,
    m.entered_with_all_sites, m.matched_at, m.confirmed_at, m.confirmed_by,
    m.sessions_synced_at, m.last_record_id, m.alerts_synced_at, m.open_session_began_at,
    m.last_status, m.status_fetched_at, m.created_at, n.entered_iccid,
    CASE WHEN n.station_iccid ~ '^[0-9]{19,20}$' THEN n.station_iccid ELSE n.entered_iccid END
      AS norm_iccid
  FROM station_sim_matches m
  JOIN charging_stations cs ON cs.id = m.station_id
  CROSS JOIN LATERAL (
    SELECT regexp_replace(upper(btrim(cs.iccid)), 'F$', '') AS station_iccid,
           regexp_replace(upper(btrim(m.entered_iccid)), 'F$', '') AS entered_iccid
  ) n
  WHERE m.provider IS NOT NULL
    AND m.provider_ref IS NOT NULL
    AND (n.station_iccid ~ '^[0-9]{19,20}$' OR n.entered_iccid ~ '^[0-9]{19,20}$')
  ORDER BY m.provider, m.provider_ref, (m.confirmed_at IS NOT NULL) DESC, m.matched_at DESC NULLS LAST;
  SELECT count(*) INTO provider_sims FROM sim_move;

  -- A primary key collision fails the migration; only an ICCID conflict is skipped.
  INSERT INTO sims (id, iccid, provider, provider_ref, provider_meta, last_status,
                    status_fetched_at, open_session_began_at, last_record_id, sessions_synced_at,
                    alerts_synced_at, created_at, updated_at)
  SELECT 'sim_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
         mv.norm_iccid, mv.provider, mv.provider_ref, mv.meta, mv.last_status,
         mv.status_fetched_at, mv.open_session_began_at, mv.last_record_id, mv.sessions_synced_at,
         mv.alerts_synced_at, mv.created_at, now()
  FROM sim_move mv
  ORDER BY (mv.confirmed_at IS NOT NULL) DESC, mv.matched_at DESC NULLS LAST
  ON CONFLICT (iccid) DO NOTHING;
  GET DIAGNOSTICS sims_made = ROW_COUNT;

  -- The station data rows of a match followed it from station to station, so
  -- a moved SIM's rows may come from another site's station. A station shows a
  -- moved SIM's rows from the migration on only.
  UPDATE sims s SET history_floor_at = now()
  FROM sim_move mv
  WHERE s.provider = mv.provider AND s.provider_ref = mv.provider_ref
    AND s.history_floor_at IS NULL;

  INSERT INTO sim_attachments (sim_id, station_id, source, attached_at, attached_by,
                               attached_with_all_sites, confirmed_at, confirmed_by)
  SELECT s.id, mv.station_id,
         CASE WHEN mv.entered_iccid = mv.norm_iccid THEN 'entered' ELSE 'reported' END,
         COALESCE(mv.matched_at, mv.created_at),
         CASE WHEN mv.entered_iccid = mv.norm_iccid THEN mv.entered_by END,
         COALESCE(mv.entered_iccid = mv.norm_iccid, false) AND mv.entered_with_all_sites,
         mv.confirmed_at, mv.confirmed_by
  FROM sim_move mv
  JOIN sims s ON s.provider = mv.provider AND s.provider_ref = mv.provider_ref
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS moved = ROW_COUNT;

  -- Entered ICCIDs of stations the first pass left without an attachment. One
  -- station per SIM: an all-site entry first, else the newest. A SIM that has
  -- an open attachment is never displaced.
  DROP TABLE IF EXISTS sim_entered;
  CREATE TEMP TABLE sim_entered ON COMMIT DROP AS
  SELECT m.station_id, n.norm_iccid, m.entered_by, m.entered_with_all_sites,
         m.lookup_missed_at, m.lookup_miss_reason, m.created_at,
         COALESCE(m.updated_at, m.created_at) AS entered_at
  FROM station_sim_matches m
  CROSS JOIN LATERAL (
    SELECT regexp_replace(upper(btrim(m.entered_iccid)), 'F$', '') AS norm_iccid
  ) n
  WHERE n.norm_iccid ~ '^[0-9]{19,20}$'
    AND NOT EXISTS (SELECT 1 FROM sim_attachments a
                    WHERE a.station_id = m.station_id AND a.detached_at IS NULL);
  SELECT count(*) INTO entered_rows FROM sim_entered;

  INSERT INTO sims (id, iccid, lookup_missed_at, lookup_miss_reason, created_by, created_at,
                    updated_at)
  SELECT DISTINCT ON (e.norm_iccid)
         'sim_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
         e.norm_iccid, e.lookup_missed_at, e.lookup_miss_reason, e.entered_by, e.created_at, now()
  FROM sim_entered e
  ORDER BY e.norm_iccid, e.entered_with_all_sites DESC, e.entered_at DESC
  ON CONFLICT (iccid) DO NOTHING;

  INSERT INTO sim_attachments (sim_id, station_id, source, attached_at, attached_by,
                               attached_with_all_sites, confirmed_at, confirmed_by)
  SELECT DISTINCT ON (s.id)
         s.id, e.station_id, 'entered', e.entered_at, e.entered_by, e.entered_with_all_sites,
         CASE WHEN e.entered_with_all_sites THEN e.entered_at END,
         CASE WHEN e.entered_with_all_sites THEN e.entered_by END
  FROM sim_entered e
  JOIN sims s ON s.iccid = e.norm_iccid
  WHERE NOT EXISTS (SELECT 1 FROM sim_attachments a WHERE a.sim_id = s.id AND a.detached_at IS NULL)
  ORDER BY s.id, e.entered_with_all_sites DESC, e.entered_at DESC;
  GET DIAGNOSTICS entered_moved = ROW_COUNT;

  -- A station whose ICCID a user entered keeps that origin, so a later
  -- Refresh attaches it as entered, not as reported.
  UPDATE charging_stations cs
  SET iccid_source = 'entered',
      iccid_entered_by = (SELECT u.id FROM users u WHERE u.id = m.entered_by),
      iccid_entered_with_all_sites = m.entered_with_all_sites
  FROM station_sim_matches m
  WHERE m.station_id = cs.id
    AND m.entered_iccid IS NOT NULL
    AND regexp_replace(upper(btrim(m.entered_iccid)), 'F$', '')
        = regexp_replace(upper(btrim(cs.iccid)), 'F$', '');

  SELECT count(*) INTO total FROM station_sim_matches;
  RAISE NOTICE 'SIM inventory: % provider SIM matches moved to an attachment, % provider SIMs not moved (ICCID conflict with another provider SIM)',
    moved, provider_sims - sims_made;
  RAISE NOTICE 'SIM inventory: % entered ICCIDs kept as an attachment, % not attached (SIM attached to another station)',
    entered_moved, entered_rows - entered_moved;
  RAISE NOTICE 'SIM inventory: % station SIM matches not moved', total - moved - entered_moved;
END $$;

--> statement-breakpoint
-- The beta.3 SIM data rows move to their SIM (sessions by provider_sim_id,
-- alerts and coverage by provider_ref). A row of no moved SIM, or without a
-- SIM ref (an earlier build stored none), shows for no SIM and is deleted.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'sim_sessions' AND column_name = 'station_id') THEN
    RETURN;
  END IF;
  ALTER TABLE "sim_sessions" ADD COLUMN IF NOT EXISTS "sim_id" text;
  UPDATE sim_sessions t SET sim_id = s.id FROM sims s
  WHERE s.provider = t.provider AND s.provider_ref = t.provider_sim_id;
  DELETE FROM sim_sessions WHERE sim_id IS NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'sim_alerts' AND column_name = 'station_id') THEN
    RETURN;
  END IF;
  ALTER TABLE "sim_alerts" ADD COLUMN IF NOT EXISTS "provider_ref" varchar(128);
  ALTER TABLE "sim_alerts" ADD COLUMN IF NOT EXISTS "sim_id" text;
  UPDATE sim_alerts t SET sim_id = s.id FROM sims s
  WHERE s.provider = t.provider AND s.provider_ref = t.provider_ref;
  DELETE FROM sim_alerts WHERE sim_id IS NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'sim_fetch_coverage' AND column_name = 'station_id') THEN
    RETURN;
  END IF;
  ALTER TABLE "sim_fetch_coverage" ADD COLUMN IF NOT EXISTS "provider_ref" varchar(128);
  ALTER TABLE "sim_fetch_coverage" ADD COLUMN IF NOT EXISTS "sim_id" text;
  UPDATE sim_fetch_coverage t SET sim_id = s.id FROM sims s
  WHERE s.provider = t.provider AND s.provider_ref = t.provider_ref;
  DELETE FROM sim_fetch_coverage WHERE sim_id IS NULL;
END $$;

--> statement-breakpoint
ALTER TABLE "sim_sessions" ALTER COLUMN "sim_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sim_alerts" ALTER COLUMN "sim_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sim_fetch_coverage" ALTER COLUMN "sim_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sim_sessions" DROP COLUMN IF EXISTS "station_id";
--> statement-breakpoint
ALTER TABLE "sim_sessions" DROP COLUMN IF EXISTS "provider_sim_id";
--> statement-breakpoint
ALTER TABLE "sim_alerts" DROP COLUMN IF EXISTS "station_id";
--> statement-breakpoint
ALTER TABLE "sim_alerts" DROP COLUMN IF EXISTS "provider_ref";
--> statement-breakpoint
ALTER TABLE "sim_fetch_coverage" DROP COLUMN IF EXISTS "station_id";
--> statement-breakpoint
ALTER TABLE "sim_fetch_coverage" DROP COLUMN IF EXISTS "provider_ref";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sim_sessions_station_started";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sim_alerts_station_received";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sim_fetch_coverage_station_from";
--> statement-breakpoint
DROP TABLE IF EXISTS "station_sim_matches";

--> statement-breakpoint
-- Keys to charging_stations, sites and users are added after the data passes,
-- so their locks are taken last.
DO $$ BEGIN
  ALTER TABLE "sims" ADD CONSTRAINT "sims_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminals" ADD CONSTRAINT "payment_terminals_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_terminals" ADD CONSTRAINT "payment_terminals_station_id_charging_stations_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_station_id_charging_stations_id_fk"
    FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_attached_by_users_id_fk"
    FOREIGN KEY ("attached_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_confirmed_by_users_id_fk"
    FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_attachments" ADD CONSTRAINT "sim_attachments_detached_by_users_id_fk"
    FOREIGN KEY ("detached_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sims" ADD CONSTRAINT "sims_deactivated_by_users_id_fk"
    FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_sessions" ADD CONSTRAINT "sim_sessions_sim_id_sims_id_fk"
    FOREIGN KEY ("sim_id") REFERENCES "public"."sims"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_alerts" ADD CONSTRAINT "sim_alerts_sim_id_sims_id_fk"
    FOREIGN KEY ("sim_id") REFERENCES "public"."sims"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sim_fetch_coverage" ADD CONSTRAINT "sim_fetch_coverage_sim_id_sims_id_fk"
    FOREIGN KEY ("sim_id") REFERENCES "public"."sims"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sim_sessions_provider_session" ON "sim_sessions" USING btree ("provider", "provider_session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_sessions_sim_started" ON "sim_sessions" USING btree ("sim_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_sessions_started" ON "sim_sessions" USING btree ("started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sim_alerts_provider_alert" ON "sim_alerts" USING btree ("provider", "provider_alert_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_alerts_sim_received" ON "sim_alerts" USING btree ("sim_id", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_alerts_received" ON "sim_alerts" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sim_fetch_coverage_sim_from" ON "sim_fetch_coverage" USING btree ("sim_id", "covered_from");

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
-- v0.1.48 security schema changes, after the data passes above and before the
-- session meter write pass.

-- Refuses a pending security profile that is not an upgrade (the data pass at
-- the top of the file cleared the stored ones).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_pending_security_profile_upgrade'
  ) THEN
    ALTER TABLE "charging_stations" ADD CONSTRAINT "ck_pending_security_profile_upgrade"
      CHECK ("pending_security_profile" IS NULL OR "pending_security_profile" > "security_profile");
  END IF;
END $$;

--> statement-breakpoint
-- The OCPI roles the operator approved for a partner. The OCPI server gates on
-- these (each module needs an approved role of its interface), never on the
-- roles a partner declares in its credentials, which it could widen in any
-- update. New partners get no role until the operator approves one. Partners
-- registered before this release keep the roles they registered with, once,
-- when the column is added: OCPI role names only, and only role entries of the
-- partner's own party.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ocpi_partners' AND column_name = 'approved_roles'
  ) THEN
    ALTER TABLE "ocpi_partners" ADD COLUMN "approved_roles" jsonb NOT NULL DEFAULT '[]'::jsonb;
    UPDATE "ocpi_partners" p SET "approved_roles" = COALESCE((
      SELECT jsonb_agg(DISTINCT r ->> 'role')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p."roles") = 'array' THEN p."roles" ELSE '[]'::jsonb END) r
      WHERE jsonb_typeof(r) = 'object'
        AND r ->> 'role' IN ('CPO', 'EMSP', 'HUB', 'NAP', 'NSP', 'OTHER', 'SCSP')
        AND r ->> 'country_code' = p."country_code"
        AND r ->> 'party_id' = p."party_id"
    ), '[]'::jsonb)
    WHERE p."status" <> 'pending';
  END IF;
END $$;
--> statement-breakpoint
-- When the operator decided the approved OCPI roles. Null means not decided yet
-- (the CSMS shows the declared roles for approval); a handshake never writes
-- either column. Partners that already registered or have approved roles get it
-- when the column is added.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ocpi_partners' AND column_name = 'roles_approved_at'
  ) THEN
    ALTER TABLE "ocpi_partners" ADD COLUMN "roles_approved_at" timestamp with time zone;
    UPDATE "ocpi_partners" SET "roles_approved_at" = now()
    WHERE "status" <> 'pending' OR "approved_roles" <> '[]'::jsonb;
  END IF;
END $$;

--> statement-breakpoint
-- SSO accounts are bound to the IdP subject (the issuer and the NameID of the
-- first SSO sign-in), never to the asserted email alone. A password account
-- signs in by SSO only after an admin allows the link (sso_link_allowed) or the
-- user confirms it.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sso_subject" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sso_link_allowed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_sso_subject" ON "users" ("sso_subject") WHERE "sso_subject" IS NOT NULL;
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'sso_link_allowed';
--> statement-breakpoint
ALTER TYPE "user_audit_action" ADD VALUE IF NOT EXISTS 'sso_unlinked';

--> statement-breakpoint
-- An SSO sign-in binds an unbound account only while its link is allowed,
-- SSO-created accounts included, so a binding an admin clears stays cleared.
-- SSO accounts created before this release hold no subject (none was stored):
-- they keep binding at their next SSO sign-in through the link permission
-- granted here. Never for an account an admin unlinked or whose link an admin
-- set, so a rerun reopens nothing. It needs the columns above; users is a small
-- table. The new enum values are compared as text only, so the file stays
-- valid in one transaction.
UPDATE "users" u
SET "sso_link_allowed" = true
WHERE u."auth_source" = 'sso'
  AND u."sso_subject" IS NULL
  AND u."sso_link_allowed" = false
  AND NOT EXISTS (
    SELECT 1 FROM "user_audit_log" a
    WHERE a."user_id" = u."id" AND a."action"::text IN ('sso_unlinked', 'sso_link_allowed')
  );

--> statement-breakpoint
-- Sign-in device cookies (OWASP "device cookies"). A browser that signed in to
-- an account before holds a cookie whose hash is a row here: its password tries
-- count on the row, not on the account, so a stranger's wrong guesses cannot
-- keep the owner's browser locked out.
CREATE TABLE IF NOT EXISTS "sign_in_devices" (
  "id" serial PRIMARY KEY,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "driver_id" text REFERENCES "drivers"("id") ON DELETE CASCADE,
  "token_hash" varchar(64) NOT NULL,
  "failed_count" integer NOT NULL DEFAULT 0,
  "locked_until" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sign_in_devices_one_account" CHECK (("user_id" IS NOT NULL) <> ("driver_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sign_in_devices_token_hash" ON "sign_in_devices" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sign_in_devices_user_id" ON "sign_in_devices" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sign_in_devices_driver_id" ON "sign_in_devices" ("driver_id");

--> statement-breakpoint
-- A webhook event counts as applied only once its apply finished: processed_at
-- is null until then, while the apply holds the event's advisory lock; a
-- redelivery that finds the row unprocessed and the lock free applies it again
-- (the process died mid-apply; the status guards make a second apply safe).
-- Existing rows keep their processed_at and count as applied. The default
-- stays, so a pod of the previous release, which never sets the column, still
-- marks its events processed at insert during a rolling upgrade.
ALTER TABLE "webhook_events" ALTER COLUMN "processed_at" DROP NOT NULL;

--> statement-breakpoint
-- Whether a stored report holds the driver identity and the money columns, set
-- from the permissions of the request that generated it (an API key's scope
-- included), so only readers who may see those columns get the report. A row
-- written without them (a report from an earlier release, or a pod of the
-- previous release during a rolling upgrade, which writes every column) counts
-- as holding both: the default stays true.
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "includes_driver_data" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "includes_money" boolean NOT NULL DEFAULT true;

--> statement-breakpoint
-- An earlier build of this file added the device a push token was registered
-- from, to keep that device's token on a password or MFA change. A client
-- header cannot prove the device, so every such change now drops all the
-- driver's push tokens, and the column goes.
ALTER TABLE "driver_push_tokens" DROP COLUMN IF EXISTS "device_id";

--> statement-breakpoint
-- Station data plans (features/station-data-plans.md): two sets of OCPP
-- station settings, Wi-Fi or wired (the existing ocpp.* keys) and Cellular
-- (ocpp.cellular.*), with AC and DC values for the readings while charging.
-- A station runs its own choice, else Cellular for a confirmed SIM, else its
-- site's plan, else Wi-Fi or wired; nothing is backfilled, the rule is read
-- where the inputs live. Small tables only, so these run with the schema
-- changes, before the session meter write pass.
DO $$ BEGIN
  CREATE TYPE "station_data_plan" AS ENUM ('wifi_or_wired', 'cellular');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "data_plan" "station_data_plan";
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "data_plan" "station_data_plan";
--> statement-breakpoint
-- The audit action of a site plan change. No statement of this file uses it.
ALTER TYPE "site_audit_action" ADD VALUE IF NOT EXISTS 'data_plan_changed';
--> statement-breakpoint
-- New plan values. ON CONFLICT DO NOTHING keeps an operator value.
INSERT INTO settings (key, value) VALUES
  ('ocpp.csmsPingInterval', '120'::jsonb),
  ('ocpp.dc.meterValueInterval', '30'::jsonb),
  ('ocpp.dc.sampledMeasurands', '"Energy.Active.Import.Register,Power.Active.Import,Current.Import,SoC"'::jsonb),
  ('ocpp.cellular.heartbeatInterval', '3600'::jsonb),
  ('ocpp.cellular.csmsPingInterval', '240'::jsonb),
  ('ocpp.cellular.meterValueInterval', '300'::jsonb),
  ('ocpp.cellular.sampledMeasurands', '"Energy.Active.Import.Register,Power.Active.Import"'::jsonb),
  ('ocpp.cellular.dc.meterValueInterval', '60'::jsonb),
  ('ocpp.cellular.dc.sampledMeasurands', '"Energy.Active.Import.Register,Power.Active.Import,SoC"'::jsonb),
  ('ocpp.cellular.clockAlignedInterval', '0'::jsonb),
  ('ocpp.cellular.alignedMeasurands', '"Energy.Active.Import.Register"'::jsonb),
  ('ocpp.cellular.txEndedMeasurands', '"Energy.Active.Import.Register"'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Changed Wi-Fi or wired defaults, only while the row still holds the old
-- shipped value, so an operator value stays. A rerun changes nothing.
UPDATE settings SET value = '900'::jsonb, updated_at = now()
WHERE key = 'ocpp.heartbeatInterval' AND value = '300'::jsonb;
--> statement-breakpoint
UPDATE settings
SET value = '"Energy.Active.Import.Register,Power.Active.Import,Current.Import"'::jsonb, updated_at = now()
WHERE key = 'ocpp.sampledMeasurands'
  AND value = '"Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import"'::jsonb;
--> statement-breakpoint
UPDATE settings SET value = '"Energy.Active.Import.Register"'::jsonb, updated_at = now()
WHERE key = 'ocpp.alignedMeasurands'
  AND value = '"Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import"'::jsonb;
--> statement-breakpoint
-- One configuration template per plan and OCPP version, with the station-side
-- values the boot push does not send. Pushed by an operator only (Target
-- Filter: the plan). Fixed ids and ON CONFLICT DO NOTHING keep an operator's
-- edit or delete. The three instanced 2.x variables name their instance.
INSERT INTO config_templates (id, name, description, ocpp_version, variables, target_filter) VALUES
  ('ctm_dataplan_wired_16', 'Wi-Fi or Wired Data Plan (OCPP 1.6)',
   'Station-side settings for OCPP 1.6 stations on the Wi-Fi or wired data plan. The heartbeat and meter value settings come from the data plan at every boot.',
   '1.6',
   '[{"component":"","variable":"WebSocketPingInterval","value":"300"},
     {"component":"","variable":"TransactionMessageAttempts","value":"3"},
     {"component":"","variable":"TransactionMessageRetryInterval","value":"60"}]'::jsonb,
   '{"dataPlan":"wifi_or_wired"}'::jsonb),
  ('ctm_dataplan_cell_16', 'Cellular Data Plan (OCPP 1.6)',
   'Station-side settings for OCPP 1.6 stations on the Cellular data plan. The heartbeat and meter value settings come from the data plan at every boot.',
   '1.6',
   '[{"component":"","variable":"WebSocketPingInterval","value":"240"},
     {"component":"","variable":"TransactionMessageAttempts","value":"5"},
     {"component":"","variable":"TransactionMessageRetryInterval","value":"120"}]'::jsonb,
   '{"dataPlan":"cellular"}'::jsonb),
  ('ctm_dataplan_wired_2x', 'Wi-Fi or Wired Data Plan (OCPP 2.0.1 and 2.1)',
   'Station-side settings for OCPP 2.0.1 and 2.1 stations on the Wi-Fi or wired data plan. The heartbeat and meter value settings come from the data plan at every boot.',
   '2.1',
   '[{"component":"OCPPCommCtrlr","variable":"WebSocketPingInterval","value":"300"},
     {"component":"OCPPCommCtrlr","variable":"QueueAllMessages","value":"false"},
     {"component":"OCPPCommCtrlr","variable":"OfflineThreshold","value":"60"},
     {"component":"OCPPCommCtrlr","variable":"RetryBackOffWaitMinimum","value":"5"},
     {"component":"OCPPCommCtrlr","variable":"RetryBackOffRandomRange","value":"10"},
     {"component":"OCPPCommCtrlr","variable":"RetryBackOffRepeatTimes","value":"5"},
     {"component":"SampledDataCtrlr","variable":"TxStartedMeasurands","value":"Energy.Active.Import.Register"},
     {"component":"SampledDataCtrlr","variable":"TxEndedInterval","value":"0"},
     {"component":"SampledDataCtrlr","variable":"RegisterValuesWithoutPhases","value":"false"},
     {"component":"AlignedDataCtrlr","variable":"SendDuringIdle","value":"false"},
     {"component":"AlignedDataCtrlr","variable":"TxEndedInterval","value":"0"},
     {"component":"OCPPCommCtrlr","variable":"MessageTimeout","variableInstance":"Default","value":"30"},
     {"component":"OCPPCommCtrlr","variable":"MessageAttempts","variableInstance":"TransactionEvent","value":"3"},
     {"component":"OCPPCommCtrlr","variable":"MessageAttemptInterval","variableInstance":"TransactionEvent","value":"60"}]'::jsonb,
   '{"dataPlan":"wifi_or_wired"}'::jsonb),
  ('ctm_dataplan_cell_2x', 'Cellular Data Plan (OCPP 2.0.1 and 2.1)',
   'Station-side settings for OCPP 2.0.1 and 2.1 stations on the Cellular data plan. The heartbeat and meter value settings come from the data plan at every boot.',
   '2.1',
   '[{"component":"OCPPCommCtrlr","variable":"WebSocketPingInterval","value":"240"},
     {"component":"OCPPCommCtrlr","variable":"QueueAllMessages","value":"true"},
     {"component":"OCPPCommCtrlr","variable":"OfflineThreshold","value":"300"},
     {"component":"OCPPCommCtrlr","variable":"RetryBackOffWaitMinimum","value":"15"},
     {"component":"OCPPCommCtrlr","variable":"RetryBackOffRandomRange","value":"30"},
     {"component":"OCPPCommCtrlr","variable":"RetryBackOffRepeatTimes","value":"5"},
     {"component":"SampledDataCtrlr","variable":"TxStartedMeasurands","value":"Energy.Active.Import.Register"},
     {"component":"SampledDataCtrlr","variable":"TxEndedInterval","value":"0"},
     {"component":"SampledDataCtrlr","variable":"RegisterValuesWithoutPhases","value":"true"},
     {"component":"AlignedDataCtrlr","variable":"SendDuringIdle","value":"true"},
     {"component":"AlignedDataCtrlr","variable":"TxEndedInterval","value":"0"},
     {"component":"OCPPCommCtrlr","variable":"MessageTimeout","variableInstance":"Default","value":"60"},
     {"component":"OCPPCommCtrlr","variable":"MessageAttempts","variableInstance":"TransactionEvent","value":"5"},
     {"component":"OCPPCommCtrlr","variable":"MessageAttemptInterval","variableInstance":"TransactionEvent","value":"120"}]'::jsonb,
   '{"dataPlan":"cellular"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

--> statement-breakpoint
-- Session meter summary, write pass: the peak overall Outlet active import power
-- in W and the newest state of charge, kept on the session because meter_values
-- is pruned after logs.meterValues.retentionDays. The OCPP projection writes
-- them with each reading. Only when this adds the columns, the sessions from
-- before the release take the values the read pass at the top of the file
-- collected, joined by primary key. Never again after that.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'charging_sessions'
      AND column_name = 'peak_power_w'
  ) THEN
    ALTER TABLE "charging_sessions" ADD COLUMN "peak_power_w" numeric;
    ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "last_soc_percent" numeric;
    ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "last_soc_at" timestamp with time zone;

    IF to_regclass('pg_temp.mv_summary_backfill') IS NOT NULL THEN
      UPDATE "charging_sessions" cs
      SET "peak_power_w" = b.peak_power_w,
          "last_soc_percent" = b.last_soc_percent,
          "last_soc_at" = b.last_soc_at
      FROM mv_summary_backfill b
      WHERE cs.id = b.session_id;
    END IF;
  END IF;
END $$;
