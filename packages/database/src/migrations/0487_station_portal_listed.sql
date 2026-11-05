-- Whether the driver portal lists a station in its search, map, nearby and
-- location pages. False hides it there; its pages by OCPP id (QR code, link,
-- favorites) and starting a session stay available.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "portal_listed" boolean DEFAULT true NOT NULL;
