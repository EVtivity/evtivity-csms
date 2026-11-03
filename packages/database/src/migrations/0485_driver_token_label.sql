-- Optional free-text label for a token, set by the operator or the driver
-- (e.g. "Pool card fleet 3"). Not part of OCPP or OCPI.
ALTER TABLE "driver_tokens" ADD COLUMN IF NOT EXISTS "label" varchar(100);
