CREATE TABLE IF NOT EXISTS "station_watches" (
	"id" serial PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"station_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "station_watches" ADD CONSTRAINT "station_watches_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "station_watches" ADD CONSTRAINT "station_watches_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "charging_stations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_station_watches_unique" ON "station_watches" ("driver_id","station_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_watches_driver" ON "station_watches" ("driver_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_watches_station" ON "station_watches" ("station_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_watches_expires" ON "station_watches" ("expires_at");
--> statement-breakpoint
INSERT INTO driver_event_settings (event_type, is_enabled) VALUES ('watch.StationAvailable', true) ON CONFLICT (event_type) DO NOTHING;
--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'station-watch-prune', '20 4 * * *', 'pending', NOW() + INTERVAL '1 day'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'station-watch-prune');
