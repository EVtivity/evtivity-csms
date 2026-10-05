-- Marks the partners that were sent REMOVED for the EVSE uids published before
-- v0.1.32 ({siteId}-{evseNumber}). Partners that exist when this runs get
-- NULL, so the OCPI server sends the one-time removal to them. Partners added
-- later never saw those uids and get now() from the column default.
ALTER TABLE "ocpi_partners" ADD COLUMN IF NOT EXISTS "legacy_evse_uids_removed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ocpi_partners" ALTER COLUMN "legacy_evse_uids_removed_at" SET DEFAULT now();
