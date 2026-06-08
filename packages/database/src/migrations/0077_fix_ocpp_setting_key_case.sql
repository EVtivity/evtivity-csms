-- 0001_seed_defaults.sql seeded OCPP keys in snake_case; all code reads camelCase.
-- Insert camelCase keys with correct defaults (preserves any operator-saved values),
-- then delete the orphaned snake_case rows that the code has never read.
-- clockAlignedInterval also bumps the default from 60 to 900 if unchanged.

INSERT INTO settings (key, value) VALUES ('ocpp.heartbeatInterval', '300'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.meterValueInterval', '60'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.clockAlignedInterval', '900'::jsonb) ON CONFLICT (key) DO UPDATE SET value = '900'::jsonb WHERE settings.value = '60'::jsonb;
INSERT INTO settings (key, value) VALUES ('ocpp.sampledMeasurands', '"Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import"'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.alignedMeasurands', '"Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import"'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.txEndedMeasurands', '"Energy.Active.Import.Register"'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.connectionTimeout', '120'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.resetRetries', '3'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.registrationPolicy', '"approval-required"'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('ocpp.offlineCommandTtlHours', '24'::jsonb) ON CONFLICT (key) DO NOTHING;

DELETE FROM settings WHERE key IN (
  'ocpp.heartbeat_interval',
  'ocpp.meter_value_interval',
  'ocpp.clock_aligned_interval',
  'ocpp.sampled_measurands',
  'ocpp.aligned_measurands',
  'ocpp.tx_ended_measurands',
  'ocpp.connection_timeout',
  'ocpp.reset_retries',
  'ocpp.registration_policy',
  'ocpp.offline_command_ttl_hours'
);
