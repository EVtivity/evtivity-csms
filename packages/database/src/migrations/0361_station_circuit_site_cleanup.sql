-- A station that moved to another site kept its circuit_id, which named a
-- circuit of the old site's panel (or a deleted circuit: the column has no
-- foreign key). Station moves now clear it; this clears the stale values.
-- Idempotent: a second run finds nothing to clear.
UPDATE "charging_stations" AS cs
SET "circuit_id" = NULL, "updated_at" = now()
WHERE cs."circuit_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "circuits" c
    INNER JOIN "panels" p ON p."id" = c."panel_id"
    WHERE c."id" = cs."circuit_id"
      AND p."site_id" IS NOT DISTINCT FROM cs."site_id"
  );
