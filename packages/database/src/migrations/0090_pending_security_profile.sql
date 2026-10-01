-- A security profile upgrade sent to a connected station is pending until the
-- station connects with the new profile. The OCPP server accepts the current or
-- the pending profile until then, and promotes the pending one on success.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "pending_security_profile" integer;
