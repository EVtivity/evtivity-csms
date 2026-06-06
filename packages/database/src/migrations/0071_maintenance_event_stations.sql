CREATE TABLE IF NOT EXISTS "maintenance_event_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"station_id" text,
	"station_id_snapshot" text NOT NULL,
	"station_ocpp_id" varchar(255) NOT NULL,
	"phase" varchar(20) NOT NULL,
	"command" varchar(80) NOT NULL,
	"command_status" varchar(20) NOT NULL,
	"error" text,
	"status_before" varchar(50),
	"status_after" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_event_stations" ADD CONSTRAINT "maintenance_event_stations_event_id_maintenance_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."maintenance_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maintenance_event_stations" ADD CONSTRAINT "maintenance_event_stations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maintenance_event_stations_event_id" ON "maintenance_event_stations" ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maintenance_event_stations_created_at" ON "maintenance_event_stations" ("created_at");
