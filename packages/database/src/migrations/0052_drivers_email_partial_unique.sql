-- Drivers email uniqueness: the schema comment claimed a partial unique
-- index existed in 0022 but no such index was ever created. Without a
-- DB-level constraint the application-layer ilike check in
-- packages/api/src/routes/drivers.ts can race under concurrent POSTs and
-- also lets case-variants slip through (e.g. Alice@x.com and alice@x.com
-- stored independently). Normalize existing emails to lowercase, then add
-- a partial unique index on lower(email) so the DB enforces the contract.

UPDATE drivers
SET email = LOWER(email)
WHERE email IS NOT NULL AND email <> LOWER(email);

CREATE UNIQUE INDEX IF NOT EXISTS uq_drivers_email_lower
  ON drivers (LOWER(email))
  WHERE email IS NOT NULL;
