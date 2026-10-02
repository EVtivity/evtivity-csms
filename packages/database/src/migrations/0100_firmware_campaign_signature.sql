-- Secure firmware update (OCPP 2.1 L01, 1.6 SignedUpdateFirmware): a campaign
-- carries the Firmware Signing certificate (PEM) and the firmware signature
-- (base64) it sends with UpdateFirmware.
ALTER TABLE "firmware_campaigns" ADD COLUMN IF NOT EXISTS "signing_certificate" text;
--> statement-breakpoint
ALTER TABLE "firmware_campaigns" ADD COLUMN IF NOT EXISTS "signature" text;
