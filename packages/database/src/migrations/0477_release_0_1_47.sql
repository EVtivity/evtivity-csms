-- v0.1.47 release migration. One file per release: extended in place during the
-- release cycle, every statement idempotent.
--
-- Lock order: the charging_sessions passes come first, so the ACCESS EXCLUSIVE
-- locks of the ALTER TABLE statements below (fleets, charging_stations) are
-- taken only after the scans and are held for the shortest time.
--
-- Cost of the charging_sessions passes (each runs only while its constraint is
-- NOT VALID, so a rerun is a no-op): the site stamp updates only the sessions
-- without a site whose station has one (the sessions v0.1.45 pods started
-- during the rolling upgrade to v0.1.46), under row locks on those rows. Each
-- VALIDATE CONSTRAINT reads the whole table once (the foreign key also reads
-- sites) under SHARE UPDATE EXCLUSIVE on charging_sessions (ROW SHARE on
-- sites), held to the commit: session inserts, updates and deletes go on;
-- VACUUM, CREATE INDEX and other ALTER TABLE on charging_sessions wait.

-- Session site (v0.1.46 contract): stamp the sessions v0.1.45 pods started
-- without a site from their station, then validate the foreign key that
-- v0.1.46 added NOT VALID. One-time: runs only while the key is NOT VALID.
-- No column tells those sessions apart from other sessions without a site, so
-- the stamp also gives the station's current site to (a) a session started
-- while its station had no site, at a station assigned to a site since, and
-- (b) a session whose site was deleted (ON DELETE SET NULL), at a station now
-- at another site. Accepted: no reliable bound on the rollout window exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_site_id_sites_id_fk' AND NOT convalidated
  ) THEN
    UPDATE "charging_sessions" s SET "site_id" = cs."site_id"
    FROM "charging_stations" cs
    WHERE s."station_id" = cs."id" AND s."site_id" IS NULL AND cs."site_id" IS NOT NULL;
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_site_id_sites_id_fk";
  END IF;
END $$;
--> statement-breakpoint
-- Member invoice session check (v0.1.46 contract): added NOT VALID in v0.1.46
-- and enforced on new writes since; validate the stored rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charging_sessions_member_billed_check' AND NOT convalidated
  ) THEN
    ALTER TABLE "charging_sessions" VALIDATE CONSTRAINT "charging_sessions_member_billed_check";
  END IF;
END $$;
--> statement-breakpoint

-- Invoice payment information (issue #42): the bank details printed in the
-- "Payment information" block of invoice PDFs and the EPC QR code switch. The
-- bank details start empty (no block without an IBAN); the QR code is on.
-- ON CONFLICT DO NOTHING keeps an operator value.
INSERT INTO "settings" ("key", "value") VALUES
  ('company.bankAccountHolder', '""'::jsonb),
  ('company.iban', '""'::jsonb),
  ('company.bic', '""'::jsonb),
  ('company.bankName', '""'::jsonb),
  ('invoice.epcQrEnabled', 'true'::jsonb)
ON CONFLICT ("key") DO NOTHING;

-- Fleet invoice date (discussion #12): run_date (the issue day, as before) or
-- period_end (the last day of the billed month).
ALTER TABLE "fleets" ADD COLUMN IF NOT EXISTS "invoice_date_mode" varchar(16) DEFAULT 'run_date' NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleets_invoice_date_mode_check'
  ) THEN
    ALTER TABLE "fleets" ADD CONSTRAINT "fleets_invoice_date_mode_check"
      CHECK ("invoice_date_mode" IN ('run_date', 'period_end'));
  END IF;
END $$;

-- Session billing recipient moves (discussion #12). Written by code only; no
-- statement of this file uses the value.
ALTER TYPE "session_audit_action" ADD VALUE IF NOT EXISTS 'billing_reassigned';

-- The OCPP-J endpoint URL each station last connected on (OCPP 2.0.1 security
-- profile upgrades send it back in SetNetworkProfile). Written at connect.
ALTER TABLE "charging_stations" ADD COLUMN IF NOT EXISTS "ocpp_endpoint_url" varchar(512);
