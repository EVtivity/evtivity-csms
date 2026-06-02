-- Two more pieces of device-storage state the simulator was losing across
-- restarts: the OCPP 2.1 authorization cache (AuthCacheCtrlr.Enabled) and
-- the OCPP 2.1 power-cycle transaction preservation snapshot. Both must
-- survive a power cycle for the simulator to mirror real-station
-- behaviour.

CREATE TABLE IF NOT EXISTS css_auth_cache (
  id text PRIMARY KEY,
  css_station_id text NOT NULL REFERENCES css_stations(id) ON DELETE CASCADE,
  id_token varchar(255) NOT NULL,
  id_token_info jsonb NOT NULL,
  cached_at timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT css_auth_cache_station_token UNIQUE (css_station_id, id_token)
);

CREATE INDEX IF NOT EXISTS idx_css_auth_cache_css_station_id
  ON css_auth_cache (css_station_id);

ALTER TABLE css_transactions
  ADD COLUMN IF NOT EXISTS preserved_at timestamp with time zone;

ALTER TABLE css_transactions
  ADD COLUMN IF NOT EXISTS preserved_data jsonb;
