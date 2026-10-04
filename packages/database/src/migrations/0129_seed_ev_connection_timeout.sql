-- A portal or guest start the station accepted but never turned into a
-- transaction (the driver did not plug in) is closed by the CSMS after the
-- station's connection timeout. This is the timeout assumed for a station
-- that has not reported its own TxCtrlr.EVConnectionTimeOut (2.1) or
-- ConnectionTimeOut (1.6), in seconds.
INSERT INTO settings (key, value) VALUES ('session.evConnectionTimeoutSeconds', '180'::jsonb) ON CONFLICT (key) DO NOTHING;
