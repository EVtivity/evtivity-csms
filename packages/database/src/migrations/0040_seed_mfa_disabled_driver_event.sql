INSERT INTO driver_event_settings (event_type, is_enabled) VALUES
  ('driver.MfaDisabled', true)
ON CONFLICT (event_type) DO NOTHING;
