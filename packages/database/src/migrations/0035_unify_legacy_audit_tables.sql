-- Unify the three pre-existing audit tables (token, reservation, pricing)
-- with the standard per-entity audit schema introduced in migration 0034.
-- Every audit table now has the same shape:
--   id, <entity>_id, <entity>_id_snapshot, action <enum>, actor audit_actor,
--   actor_user_id, actor_driver_id, actor_api_key_id, actor_label,
--   before jsonb, after jsonb, notes, created_at
--
-- For token and reservation, existing data is preserved by projecting the
-- old per-field columns into the new before/after JSONB. For pricing, the
-- single discriminated table is split into four per-entity audit tables
-- matching the existing entity_type values.

-- ===========================================================================
-- token_audit_log
-- ===========================================================================

ALTER TABLE token_audit_log ADD COLUMN IF NOT EXISTS token_id_snapshot TEXT;
ALTER TABLE token_audit_log ADD COLUMN IF NOT EXISTS actor_api_key_id TEXT;
ALTER TABLE token_audit_log ADD COLUMN IF NOT EXISTS actor_label VARCHAR(100);
ALTER TABLE token_audit_log ADD COLUMN IF NOT EXISTS before JSONB;
ALTER TABLE token_audit_log ADD COLUMN IF NOT EXISTS after JSONB;

-- Backfill snapshot from existing token id (live or the token-value snapshot).
UPDATE token_audit_log
SET token_id_snapshot = COALESCE(token_id, id_token_snapshot)
WHERE token_id_snapshot IS NULL;

-- Project the legacy per-field columns into the after JSONB. Only set after
-- when at least one of the legacy fields exists.
UPDATE token_audit_log
SET after = jsonb_strip_nulls(jsonb_build_object(
  'idToken', id_token_snapshot,
  'tokenType', token_type_snapshot,
  'driverId', driver_id_snapshot
))
WHERE after IS NULL
  AND (id_token_snapshot IS NOT NULL OR token_type_snapshot IS NOT NULL OR driver_id_snapshot IS NOT NULL);

ALTER TABLE token_audit_log ALTER COLUMN token_id_snapshot SET NOT NULL;
ALTER TABLE token_audit_log DROP COLUMN IF EXISTS id_token_snapshot;
ALTER TABLE token_audit_log DROP COLUMN IF EXISTS token_type_snapshot;
ALTER TABLE token_audit_log DROP COLUMN IF EXISTS driver_id_snapshot;

-- Switch actor from token_audit_actor to the shared audit_actor enum. The
-- three old values (operator/driver/system) are all present in audit_actor,
-- so the USING clause cast is total.
ALTER TABLE token_audit_log
  ALTER COLUMN actor TYPE audit_actor USING actor::text::audit_actor;

DROP TYPE IF EXISTS token_audit_actor;

-- ===========================================================================
-- reservation_audit_log
-- ===========================================================================

ALTER TABLE reservation_audit_log ADD COLUMN IF NOT EXISTS reservation_id_snapshot TEXT;
ALTER TABLE reservation_audit_log ADD COLUMN IF NOT EXISTS actor_api_key_id TEXT;
ALTER TABLE reservation_audit_log ADD COLUMN IF NOT EXISTS actor_label VARCHAR(100);
ALTER TABLE reservation_audit_log ADD COLUMN IF NOT EXISTS before JSONB;
ALTER TABLE reservation_audit_log ADD COLUMN IF NOT EXISTS after JSONB;

UPDATE reservation_audit_log
SET reservation_id_snapshot = reservation_id
WHERE reservation_id_snapshot IS NULL;

UPDATE reservation_audit_log
SET before = jsonb_strip_nulls(jsonb_build_object(
  'driverId', driver_id_before,
  'tokenId', token_id_before,
  'evseId', evse_id_before,
  'status', status_before,
  'expiresAt', expires_at_before
))
WHERE before IS NULL
  AND (driver_id_before IS NOT NULL OR token_id_before IS NOT NULL OR evse_id_before IS NOT NULL OR status_before IS NOT NULL OR expires_at_before IS NOT NULL);

UPDATE reservation_audit_log
SET after = jsonb_strip_nulls(jsonb_build_object(
  'driverId', driver_id_after,
  'tokenId', token_id_after,
  'evseId', evse_id_after,
  'status', status_after,
  'expiresAt', expires_at_after
))
WHERE after IS NULL
  AND (driver_id_after IS NOT NULL OR token_id_after IS NOT NULL OR evse_id_after IS NOT NULL OR status_after IS NOT NULL OR expires_at_after IS NOT NULL);

-- Coalesce snapshot from either side if reservation_id was null.
UPDATE reservation_audit_log
SET reservation_id_snapshot = COALESCE(reservation_id_snapshot, reservation_id, 'unknown')
WHERE reservation_id_snapshot IS NULL;

ALTER TABLE reservation_audit_log ALTER COLUMN reservation_id_snapshot SET NOT NULL;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS driver_id_before;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS driver_id_after;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS token_id_before;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS token_id_after;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS evse_id_before;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS evse_id_after;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS status_before;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS status_after;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS expires_at_before;
ALTER TABLE reservation_audit_log DROP COLUMN IF EXISTS expires_at_after;

ALTER TABLE reservation_audit_log
  ALTER COLUMN actor TYPE audit_actor USING actor::text::audit_actor;

DROP TYPE IF EXISTS reservation_audit_actor;

-- ===========================================================================
-- pricing_audit_log split: pricing_group / tariff / holiday / pricing_assignment
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE pricing_group_audit_action AS ENUM ('created', 'updated', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE tariff_audit_action AS ENUM ('created', 'updated', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE holiday_audit_action AS ENUM ('created', 'updated', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE pricing_assignment_audit_action AS ENUM ('created', 'updated', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS pricing_group_audit_log (
  id SERIAL PRIMARY KEY,
  pricing_group_id TEXT,
  pricing_group_id_snapshot TEXT NOT NULL,
  action pricing_group_audit_action NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_pricing_group_audit_id ON pricing_group_audit_log(pricing_group_id);
CREATE INDEX IF NOT EXISTS idx_pricing_group_audit_created_at ON pricing_group_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS tariff_audit_log (
  id SERIAL PRIMARY KEY,
  tariff_id TEXT,
  tariff_id_snapshot TEXT NOT NULL,
  action tariff_audit_action NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_tariff_audit_id ON tariff_audit_log(tariff_id);
CREATE INDEX IF NOT EXISTS idx_tariff_audit_created_at ON tariff_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS holiday_audit_log (
  id SERIAL PRIMARY KEY,
  holiday_id TEXT,
  holiday_id_snapshot TEXT NOT NULL,
  action holiday_audit_action NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_holiday_audit_id ON holiday_audit_log(holiday_id);
CREATE INDEX IF NOT EXISTS idx_holiday_audit_created_at ON holiday_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS pricing_assignment_audit_log (
  id SERIAL PRIMARY KEY,
  pricing_assignment_id TEXT,
  pricing_assignment_id_snapshot TEXT NOT NULL,
  action pricing_assignment_audit_action NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_pricing_assignment_audit_id ON pricing_assignment_audit_log(pricing_assignment_id);
CREATE INDEX IF NOT EXISTS idx_pricing_assignment_audit_created_at ON pricing_assignment_audit_log(created_at DESC);

-- Migrate existing data. Default actor is 'operator' when actor_user_id is
-- set, else 'system' (the legacy table did not record the actor enum).
-- Guarded so a re-run after pricing_audit_log has been dropped is a no-op.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'pricing_audit_log'
  ) THEN
    INSERT INTO pricing_group_audit_log (
      pricing_group_id, pricing_group_id_snapshot, action, actor,
      actor_user_id, before, after, notes, created_at
    )
    SELECT entity_id, entity_id, action::text::pricing_group_audit_action,
           (CASE WHEN actor_user_id IS NOT NULL THEN 'operator' ELSE 'system' END)::audit_actor,
           actor_user_id, before, after, notes, created_at
    FROM pricing_audit_log
    WHERE entity_type = 'pricing_group';

    INSERT INTO tariff_audit_log (
      tariff_id, tariff_id_snapshot, action, actor,
      actor_user_id, before, after, notes, created_at
    )
    SELECT entity_id, entity_id, action::text::tariff_audit_action,
           (CASE WHEN actor_user_id IS NOT NULL THEN 'operator' ELSE 'system' END)::audit_actor,
           actor_user_id, before, after, notes, created_at
    FROM pricing_audit_log
    WHERE entity_type = 'tariff';

    INSERT INTO holiday_audit_log (
      holiday_id, holiday_id_snapshot, action, actor,
      actor_user_id, before, after, notes, created_at
    )
    SELECT entity_id, entity_id, action::text::holiday_audit_action,
           (CASE WHEN actor_user_id IS NOT NULL THEN 'operator' ELSE 'system' END)::audit_actor,
           actor_user_id, before, after, notes, created_at
    FROM pricing_audit_log
    WHERE entity_type = 'holiday';

    INSERT INTO pricing_assignment_audit_log (
      pricing_assignment_id, pricing_assignment_id_snapshot, action, actor,
      actor_user_id, before, after, notes, created_at
    )
    SELECT entity_id, entity_id, action::text::pricing_assignment_audit_action,
           (CASE WHEN actor_user_id IS NOT NULL THEN 'operator' ELSE 'system' END)::audit_actor,
           actor_user_id, before, after, notes, created_at
    FROM pricing_audit_log
    WHERE entity_type = 'pricing_assignment';
  END IF;
END $$;

DROP TABLE IF EXISTS pricing_audit_log;
DROP TYPE IF EXISTS pricing_audit_entity;
DROP TYPE IF EXISTS pricing_audit_action;
