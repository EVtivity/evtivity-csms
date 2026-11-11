-- v0.1.51 release migration. Idempotent: every statement can run again.
--
-- Driver RFID self-service: whether drivers add, rename, deactivate, reactivate
-- and remove their own RFID cards in the portal and the mobile app. On by
-- default (the behavior before the setting); an operator's stored value stays.
INSERT INTO settings (key, value) VALUES ('portal.rfidSelfServiceEnabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Defaults of new driver accounts (Settings > Company): the distance unit and
-- the language a driver starts with when the request sets none. The time zone
-- already comes from system.timezone. Existing values stay.
INSERT INTO "settings" ("key", "value") VALUES
  ('system.distanceUnit', '"miles"'),
  ('system.driverLanguage', '"en"')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Security events dashboard card: the securityEvents:read permission, a role
-- default of operators (viewers do not get it). Granted once: while no user
-- holds it yet. The admin grant below and sync-admin-permissions.ts (after
-- every migrate) give it to admins, so a rerun skips this block and never
-- grants back a permission an admin removed from an operator.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_permissions WHERE permission = 'securityEvents:read') THEN
    INSERT INTO user_permissions (user_id, permission)
    SELECT u.id, 'securityEvents:read'
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'operator'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
-- Admins hold every catalog permission. sync-admin-permissions.ts grants them
-- after each migrate as well; this statement keeps the grant for an install
-- that runs the SQL alone. Permissions are read per request, so no session ends.
INSERT INTO "user_permissions" ("user_id", "permission")
SELECT u."id", p."permission"
FROM "users" u
JOIN "roles" r ON r."id" = u."role_id" AND r."name" = 'admin'
CROSS JOIN (VALUES ('securityEvents:read'), ('securityEvents:write')) AS p("permission")
ON CONFLICT ("user_id", "permission") DO NOTHING;
--> statement-breakpoint
-- Security event severities: stored rows take the v0.1.51 rating of their
-- type, the table of @evtivity/lib/security-severity (SECURITY_SEVERITY_TABLE;
-- a database guard test fails when the pairs below differ from it). A type the
-- table does not list is info. Only rows whose severity changes are written, so
-- a rerun writes nothing. A plain UPDATE: no station status changes, and the
-- critical event auto-disable (the OCPP projection, on a new event only) does
-- not run. Cost: one scan of security_events and a write of the re-rated rows
-- only, in the file transaction (row locks on those rows; new event inserts go
-- on).
UPDATE security_events se
SET severity = r.severity
FROM (
  SELECT e.id, COALESCE(m.severity, 'info') AS severity
  FROM security_events e
  LEFT JOIN (VALUES
    ('TamperDetectionActivated', 'critical'),
    ('TiltDetected', 'critical'),
    ('CableCutDetected', 'critical'),
    ('SettingSystemTime', 'critical'),
    ('InvalidFirmwareSignature', 'critical'),
    ('AttemptedReplayAttacks', 'critical'),
    ('AttemptedReplayAttack', 'critical'),
    ('FailedToAuthenticateAtCentralSystem', 'high'),
    ('FailedToAuthenticateAtCsms', 'high'),
    ('CentralSystemFailedToAuthenticate', 'high'),
    ('CsmsFailedToAuthenticate', 'high'),
    ('InvalidCentralSystemCertificate', 'high'),
    ('InvalidCsmsCertificate', 'high'),
    ('InvalidChargePointCertificate', 'high'),
    ('InvalidChargingStationCertificate', 'high'),
    ('InvalidFirmwareSigningCertificate', 'high'),
    ('InvalidTLSVersion', 'high'),
    ('InvalidTLSCipherSuite', 'high'),
    ('MaintenanceLoginFailed', 'high'),
    ('SecurityLogWasCleared', 'high'),
    ('InvalidMessages', 'medium'),
    ('MemoryExhaustion', 'medium'),
    ('ReconfigurationOfSecurityParameters', 'medium'),
    ('DiscardedRenewedClientCertificate', 'medium'),
    ('StartupOfTheDevice', 'low'),
    ('ResetOrReboot', 'low'),
    ('MaintenanceLoginAccepted', 'info'),
    ('FirmwareUpdated', 'info')
  ) AS m(type, severity) ON m.type = e.type
  WHERE e.severity IS DISTINCT FROM COALESCE(m.severity, 'info')
) AS r
WHERE se.id = r.id;
--> statement-breakpoint
-- CSMS update check (security review case 385): the worker reads the latest
-- stable release from the EVtivity website once a day and stores it here, so
-- no browser contacts the website. One row, written by the cron only.
CREATE TABLE IF NOT EXISTS "csms_update_checks" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "latest_version" varchar(64),
  "checked_at" timestamp with time zone,
  "attempted_at" timestamp with time zone NOT NULL,
  CONSTRAINT "csms_update_checks_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
-- The off switch (Settings > Company): on by default, the behavior before
-- the setting; an operator's stored value stays.
INSERT INTO "settings" ("key", "value") VALUES ('system.updateCheckEnabled', 'true'::jsonb)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'csms-update-check', '41 3 * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'csms-update-check');
--> statement-breakpoint
-- Driver notification preferences per event (discussion 56). Operators make a
-- driver event mandatory per channel next to its on/off switch; no event is
-- mandatory at first. An event turned off stays off, mandatory or not.
ALTER TABLE "driver_event_settings" ADD COLUMN IF NOT EXISTS "email_mandatory" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "driver_event_settings" ADD COLUMN IF NOT EXISTS "sms_mandatory" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "driver_event_settings" ADD COLUMN IF NOT EXISTS "push_mandatory" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- A driver's choice of one event on one channel. No rows are written here:
-- an event without a row follows the driver's channel switch
-- (driver_notification_preferences), so every driver keeps what they got
-- before (channel on means every event on, channel off means every event off).
CREATE TABLE IF NOT EXISTS "driver_notification_event_preferences" (
  "driver_id" text NOT NULL REFERENCES "drivers"("id") ON DELETE CASCADE,
  "event_type" varchar(255) NOT NULL,
  "channel" varchar(10) NOT NULL,
  "enabled" boolean NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "driver_notification_event_preferences_driver_id_event_type_channel_pk" PRIMARY KEY ("driver_id", "event_type", "channel"),
  CONSTRAINT "driver_notification_event_prefs_channel_check" CHECK ("channel" IN ('email', 'sms', 'push'))
);
--> statement-breakpoint
-- UI themes: the theme a CSMS user or a driver picks on the own account
-- (Default, Soft, High Contrast). theme_preference stays the light or dark
-- mode with its stored values. Every account starts on Default.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ui_theme" varchar(20) DEFAULT 'default' NOT NULL;
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "ui_theme" varchar(20) DEFAULT 'default' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_ui_theme_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_ui_theme_check" CHECK ("ui_theme" IN ('default', 'soft', 'high-contrast'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_ui_theme_check') THEN
    ALTER TABLE "drivers" ADD CONSTRAINT "drivers_ui_theme_check" CHECK ("ui_theme" IN ('default', 'soft', 'high-contrast'));
  END IF;
END $$;
