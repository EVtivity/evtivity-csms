DELETE FROM "css_stations" WHERE "station_id" NOT IN (SELECT "station_id" FROM "charging_stations");--> statement-breakpoint
ALTER TABLE "css_stations" ADD CONSTRAINT "css_stations_station_id_charging_stations_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_stations" DROP COLUMN "ocpp_protocol";--> statement-breakpoint
ALTER TABLE "css_stations" DROP COLUMN "security_profile";--> statement-breakpoint
ALTER TABLE "css_stations" DROP COLUMN "vendor_name";--> statement-breakpoint
ALTER TABLE "css_stations" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "css_stations" DROP COLUMN "serial_number";--> statement-breakpoint
ALTER TABLE "css_stations" DROP COLUMN "firmware_version";