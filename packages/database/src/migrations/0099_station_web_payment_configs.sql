-- Dynamic QR code ad hoc payments (OCPP 2.1 C25): the WebPaymentsCtrlr values
-- the CSMS set on a station, with the shared secret encrypted at rest.
CREATE TABLE IF NOT EXISTS "station_web_payment_configs" (
	"station_id" text PRIMARY KEY NOT NULL,
	"shared_secret_enc" text NOT NULL,
	"validity_seconds" integer NOT NULL,
	"totp_length" integer NOT NULL,
	"totp_version" varchar(10) NOT NULL,
	"url_template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "station_web_payment_configs" ADD CONSTRAINT "station_web_payment_configs_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
