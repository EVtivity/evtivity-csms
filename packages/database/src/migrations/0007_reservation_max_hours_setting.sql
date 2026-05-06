-- Add reservation.maxHours system setting (default 3). Caps how long a single
-- reservation window can be. Both API endpoints (operator + portal create)
-- enforce this; both UIs surface the value as a hint near the date pickers.
-- settings.value is JSONB (no description column) -- match the cast pattern
-- used elsewhere in 0001_seed_defaults.sql.
INSERT INTO settings (key, value) VALUES
  ('reservation.maxHours', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;
