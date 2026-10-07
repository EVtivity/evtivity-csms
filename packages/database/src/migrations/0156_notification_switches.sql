-- System notifications are always on, and the access-critical driver notifications
-- (password reset, account verification, portal invite, MFA code) cannot be turned
-- off. Re-enable any stored disabled row for them. Idempotent.

UPDATE system_event_settings
SET is_enabled = true, updated_at = now()
WHERE is_enabled = false;
--> statement-breakpoint
UPDATE driver_event_settings
SET is_enabled = true, updated_at = now()
WHERE is_enabled = false
  AND event_type IN (
    'driver.ForgotPassword',
    'driver.AccountVerification',
    'driver.PortalInvite',
    'mfa.VerificationCode'
  );
