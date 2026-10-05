-- ISO 15118 contract certificate provisioning by the local contract CA
-- (pnc.provider = 'local'). pnc_contracts binds an eMAID driver token to the
-- vehicle PCID that may install it. pnc_contract_certificates records every
-- contract certificate the CA issued (revocation status for C07 and the
-- ISO 15118-20 delivery order). Settings: the eMAID country code and
-- provider ID, and the encrypted CA bundle (certificates and private keys),
-- which the operator creates in Settings > Plug & Charge. Idempotent.

DO $$
BEGIN
  CREATE TYPE pnc_contract_status AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pnc_contracts (
  id serial PRIMARY KEY,
  driver_token_id text NOT NULL REFERENCES driver_tokens(id) ON DELETE CASCADE,
  pcid varchar(64) NOT NULL,
  status pnc_contract_status NOT NULL DEFAULT 'active',
  revoked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pnc_contracts_driver_token ON pnc_contracts (driver_token_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pnc_contracts_pcid_status ON pnc_contracts (pcid, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pnc_contract_certificates (
  id serial PRIMARY KEY,
  contract_id integer NOT NULL REFERENCES pnc_contracts(id) ON DELETE CASCADE,
  station_id text REFERENCES charging_stations(id) ON DELETE SET NULL,
  pcid varchar(64) NOT NULL,
  schema_version smallint NOT NULL,
  serial_number varchar(64) NOT NULL,
  valid_to timestamp with time zone NOT NULL,
  issued_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pnc_contract_certificates_serial ON pnc_contract_certificates (serial_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pnc_contract_certificates_contract ON pnc_contract_certificates (contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pnc_contract_certificates_delivery ON pnc_contract_certificates (station_id, pcid, issued_at);
--> statement-breakpoint
INSERT INTO settings (key, value) VALUES
  ('pnc.local.emaidCountry', '""'::jsonb),
  ('pnc.local.emaidProviderId', '""'::jsonb),
  ('pnc.local.caEnc', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;
