-- Add reservation.activeSessionCheckHours system setting (default 3).
-- When the requested reservation startsAt is within this many hours of "now",
-- the API rejects the request if the targeted EVSE has an active charging
-- session. Set to 0 to disable the check.
INSERT INTO settings (key, value)
VALUES
  ('reservation.activeSessionCheckHours', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;
