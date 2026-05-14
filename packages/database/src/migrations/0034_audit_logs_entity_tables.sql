-- Per-entity audit tables. One table per audited entity. Each table has the
-- same shape, only the action enum differs. entity_id is nullable so audit
-- rows survive hard-delete; entity_id_snapshot (text) preserves the original
-- identifier even when the source row is gone. before/after JSONB hold full
-- row snapshots for diffability and reconstruction. No FKs to the entity
-- itself for the same survive-hard-delete reason.
--
-- Every CREATE TYPE is wrapped in a DO block with EXCEPTION duplicate_object
-- so the migration is idempotent (re-running on a partially-applied DB does
-- not fail). Every CREATE TABLE / CREATE INDEX uses IF NOT EXISTS for the
-- same reason.

-- Sites ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE site_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'payment_config_changed', 'free_vend_toggled',
    'carbon_region_changed', 'pricing_assignment_changed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS site_audit_log (
  id SERIAL PRIMARY KEY,
  site_id TEXT,
  site_id_snapshot TEXT NOT NULL,
  action site_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_site_audit_site_id ON site_audit_log(site_id);
CREATE INDEX IF NOT EXISTS idx_site_audit_created_at ON site_audit_log(created_at DESC);

-- Stations ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE station_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'availability_changed', 'onboarding_status_changed',
    'pricing_assignment_changed', 'simulator_toggled',
    'command_dispatched', 'certificate_installed',
    'configuration_pushed', 'local_auth_pushed', 'reset_triggered'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS station_audit_log (
  id SERIAL PRIMARY KEY,
  station_id TEXT,
  station_id_snapshot TEXT NOT NULL,
  action station_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_station_audit_station_id ON station_audit_log(station_id);
CREATE INDEX IF NOT EXISTS idx_station_audit_created_at ON station_audit_log(created_at DESC);

-- Drivers -------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE driver_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'activated', 'deactivated',
    'password_reset', 'email_verified',
    'fleet_assignment_changed', 'pricing_assignment_changed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS driver_audit_log (
  id SERIAL PRIMARY KEY,
  driver_id TEXT,
  driver_id_snapshot TEXT NOT NULL,
  action driver_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_audit_driver_id ON driver_audit_log(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_audit_created_at ON driver_audit_log(created_at DESC);

-- Fleets --------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE fleet_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'member_added', 'member_removed',
    'station_added', 'station_removed',
    'pricing_assignment_changed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fleet_audit_log (
  id SERIAL PRIMARY KEY,
  fleet_id TEXT,
  fleet_id_snapshot TEXT NOT NULL,
  action fleet_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_audit_fleet_id ON fleet_audit_log(fleet_id);
CREATE INDEX IF NOT EXISTS idx_fleet_audit_created_at ON fleet_audit_log(created_at DESC);

-- Users ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'password_reset', 'mfa_enabled', 'mfa_disabled',
    'role_changed', 'permissions_changed', 'site_access_changed',
    'login_succeeded', 'login_failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS user_audit_log (
  id SERIAL PRIMARY KEY,
  user_id TEXT,
  user_id_snapshot TEXT NOT NULL,
  action user_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_audit_user_id ON user_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_user_audit_created_at ON user_audit_log(created_at DESC);

-- Vehicles ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE vehicle_audit_action AS ENUM ('created', 'updated', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vehicle_audit_log (
  id SERIAL PRIMARY KEY,
  vehicle_id TEXT,
  vehicle_id_snapshot TEXT NOT NULL,
  action vehicle_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_audit_vehicle_id ON vehicle_audit_log(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_audit_created_at ON vehicle_audit_log(created_at DESC);

-- Support cases -------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE support_case_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'status_changed', 'priority_changed', 'category_changed', 'assigned',
    'message_added', 'attachment_added', 'refund_issued',
    'sessions_linked', 'sessions_unlinked'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS support_case_audit_log (
  id SERIAL PRIMARY KEY,
  support_case_id TEXT,
  support_case_id_snapshot TEXT NOT NULL,
  action support_case_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_case_audit_case_id ON support_case_audit_log(support_case_id);
CREATE INDEX IF NOT EXISTS idx_support_case_audit_created_at ON support_case_audit_log(created_at DESC);

-- OCPI partners -------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE ocpi_partner_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'registered', 'disconnected', 'sync_triggered',
    'location_published_changed', 'tariff_mapping_changed', 'token_received'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ocpi_partner_audit_log (
  id SERIAL PRIMARY KEY,
  ocpi_partner_id TEXT,
  ocpi_partner_id_snapshot TEXT NOT NULL,
  action ocpi_partner_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ocpi_partner_audit_partner_id ON ocpi_partner_audit_log(ocpi_partner_id);
CREATE INDEX IF NOT EXISTS idx_ocpi_partner_audit_created_at ON ocpi_partner_audit_log(created_at DESC);

-- Certificates (PnC) --------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE certificate_audit_action AS ENUM (
    'csr_signed', 'csr_rejected',
    'certificate_installed', 'certificate_deleted',
    'ca_certificate_added', 'ca_certificate_deleted',
    'root_certificates_refreshed', 'pnc_settings_updated'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS certificate_audit_log (
  id SERIAL PRIMARY KEY,
  certificate_id TEXT,
  certificate_id_snapshot TEXT NOT NULL,
  action certificate_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_certificate_audit_cert_id ON certificate_audit_log(certificate_id);
CREATE INDEX IF NOT EXISTS idx_certificate_audit_created_at ON certificate_audit_log(created_at DESC);

-- Roles ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE role_audit_action AS ENUM (
    'created', 'updated', 'deleted', 'permissions_changed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS role_audit_log (
  id SERIAL PRIMARY KEY,
  role_id TEXT,
  role_id_snapshot TEXT NOT NULL,
  action role_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_role_audit_role_id ON role_audit_log(role_id);
CREATE INDEX IF NOT EXISTS idx_role_audit_created_at ON role_audit_log(created_at DESC);

-- API keys ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE api_key_audit_action AS ENUM (
    'created', 'updated', 'deleted', 'revoked', 'used'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS api_key_audit_log (
  id SERIAL PRIMARY KEY,
  api_key_id TEXT,
  api_key_id_snapshot TEXT NOT NULL,
  action api_key_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_key_id ON api_key_audit_log(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_created_at ON api_key_audit_log(created_at DESC);

-- Settings ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE setting_audit_action AS ENUM ('updated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS setting_audit_log (
  id SERIAL PRIMARY KEY,
  setting_key TEXT,
  setting_key_snapshot TEXT NOT NULL,
  action setting_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_setting_audit_key ON setting_audit_log(setting_key);
CREATE INDEX IF NOT EXISTS idx_setting_audit_created_at ON setting_audit_log(created_at DESC);

-- Smart charging templates --------------------------------------------------
DO $$ BEGIN
  CREATE TYPE smart_charging_template_audit_action AS ENUM (
    'created', 'updated', 'deleted', 'pushed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS smart_charging_template_audit_log (
  id SERIAL PRIMARY KEY,
  template_id TEXT,
  template_id_snapshot TEXT NOT NULL,
  action smart_charging_template_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_smart_charging_template_audit_template_id ON smart_charging_template_audit_log(template_id);
CREATE INDEX IF NOT EXISTS idx_smart_charging_template_audit_created_at ON smart_charging_template_audit_log(created_at DESC);

-- Config templates ----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE config_template_audit_action AS ENUM (
    'created', 'updated', 'deleted', 'pushed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS config_template_audit_log (
  id SERIAL PRIMARY KEY,
  template_id TEXT,
  template_id_snapshot TEXT NOT NULL,
  action config_template_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_config_template_audit_template_id ON config_template_audit_log(template_id);
CREATE INDEX IF NOT EXISTS idx_config_template_audit_created_at ON config_template_audit_log(created_at DESC);

-- Firmware campaigns --------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE firmware_campaign_audit_action AS ENUM (
    'created', 'updated', 'deleted',
    'started', 'paused', 'resumed', 'completed', 'cancelled',
    'station_added', 'station_removed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS firmware_campaign_audit_log (
  id SERIAL PRIMARY KEY,
  campaign_id TEXT,
  campaign_id_snapshot TEXT NOT NULL,
  action firmware_campaign_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_firmware_campaign_audit_campaign_id ON firmware_campaign_audit_log(campaign_id);
CREATE INDEX IF NOT EXISTS idx_firmware_campaign_audit_created_at ON firmware_campaign_audit_log(created_at DESC);

-- Station images ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE station_image_audit_action AS ENUM (
    'uploaded', 'updated', 'deleted', 'set_main'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS station_image_audit_log (
  id SERIAL PRIMARY KEY,
  station_image_id TEXT,
  station_image_id_snapshot TEXT NOT NULL,
  action station_image_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_station_image_audit_image_id ON station_image_audit_log(station_image_id);
CREATE INDEX IF NOT EXISTS idx_station_image_audit_created_at ON station_image_audit_log(created_at DESC);

-- Local auth list -----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE local_auth_list_audit_action AS ENUM (
    'tokens_added', 'tokens_removed', 'pushed', 'pulled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS local_auth_list_audit_log (
  id SERIAL PRIMARY KEY,
  station_id TEXT,
  station_id_snapshot TEXT NOT NULL,
  action local_auth_list_audit_action NOT NULL,
  actor audit_actor NOT NULL,
  actor_user_id TEXT,
  actor_driver_id TEXT,
  actor_api_key_id TEXT,
  actor_label VARCHAR(100),
  before JSONB,
  after JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_local_auth_list_audit_station_id ON local_auth_list_audit_log(station_id);
CREATE INDEX IF NOT EXISTS idx_local_auth_list_audit_created_at ON local_auth_list_audit_log(created_at DESC);
