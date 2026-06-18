ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "device_id" varchar(64);
