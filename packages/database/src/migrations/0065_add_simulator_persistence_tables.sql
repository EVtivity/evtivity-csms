-- Add the device-storage tables the simulator's PersistedCache layer
-- expects for state that is otherwise lost on restart: variable monitors,
-- customer-information key-value store, and the offline OCPP message
-- queue. Also adds an entry_data jsonb column on css_local_auth_entries so
-- the simulator can round-trip the full OCPP LocalList payload instead of
-- the lossy column-scalar shape.

ALTER TABLE css_local_auth_entries
  ADD COLUMN IF NOT EXISTS entry_data jsonb;

CREATE TABLE IF NOT EXISTS css_variable_monitors (
  id text PRIMARY KEY,
  css_station_id text NOT NULL REFERENCES css_stations(id) ON DELETE CASCADE,
  monitor_id integer NOT NULL,
  monitor_data jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT css_variable_monitors_station_monitor UNIQUE (css_station_id, monitor_id)
);

CREATE INDEX IF NOT EXISTS idx_css_variable_monitors_css_station_id
  ON css_variable_monitors (css_station_id);

CREATE TABLE IF NOT EXISTS css_customer_data (
  id text PRIMARY KEY,
  css_station_id text NOT NULL REFERENCES css_stations(id) ON DELETE CASCADE,
  key varchar(255) NOT NULL,
  value text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT css_customer_data_station_key UNIQUE (css_station_id, key)
);

CREATE INDEX IF NOT EXISTS idx_css_customer_data_css_station_id
  ON css_customer_data (css_station_id);

CREATE TABLE IF NOT EXISTS css_offline_messages (
  id text PRIMARY KEY,
  css_station_id text NOT NULL REFERENCES css_stations(id) ON DELETE CASCADE,
  action varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  queued_at timestamp with time zone NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_css_offline_messages_css_station_id
  ON css_offline_messages (css_station_id);
