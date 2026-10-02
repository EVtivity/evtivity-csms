-- The simulator keeps the PEM of each certificate it installs, so it can check
-- signatures and certificate chains against its installed root certificates.
ALTER TABLE "css_installed_certificates" ADD COLUMN IF NOT EXISTS "certificate" text;
