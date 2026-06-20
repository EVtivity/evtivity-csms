-- Namespace the mobile device-attestation settings under mobile.* so all
-- mobile-only config groups together. Renames the seven keys seeded by 0083.
-- Idempotent: only renames when the new key does not already exist, and drops
-- a stale old key when the new one is already present (fresh installs seed the
-- new key directly, so 0083's insert + this rename can leave both briefly).
UPDATE settings s
SET key = 'mobile.' || s.key
WHERE s.key LIKE 'attestation.%'
  AND NOT EXISTS (SELECT 1 FROM settings t WHERE t.key = 'mobile.' || s.key);
--> statement-breakpoint
DELETE FROM settings s
WHERE s.key LIKE 'attestation.%'
  AND EXISTS (SELECT 1 FROM settings t WHERE t.key = 'mobile.' || s.key);
