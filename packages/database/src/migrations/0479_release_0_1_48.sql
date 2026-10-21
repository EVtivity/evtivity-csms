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
