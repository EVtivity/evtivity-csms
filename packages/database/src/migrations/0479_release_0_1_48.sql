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
-- Driver session versions: a driver access token carries the version it was
-- issued under (`sv`), so a password reset or change, a sign-out or a
-- deactivation ends the access tokens issued before it. Existing tokens carry
-- no version and count as 0, the default, so the upgrade signs no one out.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;
