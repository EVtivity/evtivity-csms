-- OCPI location ids are unique (v0.1.43). A partner resolves a location_id
-- by the custom ocpi_location_id first, then by the site id, so two rows with
-- the same custom id, or a custom id equal to another site's id, made the
-- lookup pick an arbitrary site. Clear the colliding values first: an empty
-- id, every duplicate except the oldest row's, and any id equal to another
-- site's id. A cleared row falls back to its site id, the default location id.
UPDATE "ocpi_location_publish" SET "ocpi_location_id" = NULL WHERE "ocpi_location_id" = '';
--> statement-breakpoint
UPDATE "ocpi_location_publish" p SET "ocpi_location_id" = NULL
WHERE p."ocpi_location_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "ocpi_location_publish" o
    WHERE o."ocpi_location_id" = p."ocpi_location_id" AND o."id" < p."id"
  );
--> statement-breakpoint
UPDATE "ocpi_location_publish" p SET "ocpi_location_id" = NULL
WHERE p."ocpi_location_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "sites" s
    WHERE s."id" = p."ocpi_location_id" AND s."id" <> p."site_id"
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ocpi_location_publish_location_id"
  ON "ocpi_location_publish" ("ocpi_location_id")
  WHERE "ocpi_location_id" IS NOT NULL;
