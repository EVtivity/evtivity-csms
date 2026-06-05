-- Seed the driver_event_settings row for the invoice.Sent driver event so it
-- dispatches by default. Idempotent via ON CONFLICT DO NOTHING.

INSERT INTO driver_event_settings (event_type, is_enabled)
VALUES ('invoice.Sent', true)
ON CONFLICT (event_type) DO NOTHING;
