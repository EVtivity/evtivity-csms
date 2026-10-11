-- Insight card cleanup (v0.1.45, plan 2026-10-11 section 5, P13): insights no
-- longer carry the all-sites (network) counts. Removes the stored key; the
-- site counts stay. Idempotent: a rerun finds no row with the key.
UPDATE "ai_insights" SET "scope" = "scope" - 'network' WHERE "scope" ? 'network';
