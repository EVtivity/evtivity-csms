-- OCPP 2.1 local cost calculation: the tariff id and cost details a station
-- reports for a transaction (I08.FR.22, I11.FR.07, I12), and the difference
-- between the station's total and the billed final cost. Nullable columns
-- only, no backfill, idempotent.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "station_tariff_id" varchar(60);--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "station_cost_details" jsonb;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "station_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "station_cost_difference_cents" integer;
