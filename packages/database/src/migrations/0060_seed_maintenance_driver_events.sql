-- Seed driver_event_settings rows for the two new maintenance-related driver
-- event types so they dispatch by default. Idempotent via ON CONFLICT DO NOTHING.

INSERT INTO driver_event_settings (event_type, is_enabled)
VALUES
  ('reservation.CancelledForMaintenance', true),
  ('maintenance.SessionStopped', true)
ON CONFLICT (event_type) DO NOTHING;
