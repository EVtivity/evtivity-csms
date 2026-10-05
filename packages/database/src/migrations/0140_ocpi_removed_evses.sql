-- EVSEs that left an OCPI location (deleted, or their station moved to another
-- site). The location serves them with status REMOVED for a retention period
-- (OCPI 2.3.0 8.1: EVSEs are never deleted for partners).
CREATE TABLE IF NOT EXISTS "ocpi_removed_evses" (
  "evse_uid" text NOT NULL,
  "site_id" text NOT NULL,
  "station_ocpp_id" varchar(255) NOT NULL,
  "evse_number" integer NOT NULL,
  "connectors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "removed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ocpi_removed_evses_evse_uid_site_id_pk" PRIMARY KEY ("evse_uid", "site_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ocpi_removed_evses" ADD CONSTRAINT "ocpi_removed_evses_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ocpi_removed_evses_site" ON "ocpi_removed_evses" USING btree ("site_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ocpi_removed_evses_removed_at" ON "ocpi_removed_evses" USING btree ("removed_at");
