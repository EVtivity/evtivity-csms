-- Simulated OCPP 2.1 stations get a new factory reconnect back-off
-- (OCPPCommCtrlr.RetryBackOffWaitMinimum 2 s, RetryBackOffRandomRange 15 s), so a
-- simulator fleet spreads its reconnects after an OCPP server restart over 15 s
-- instead of 5 s. Stations persist their device model, so existing rows still
-- at the previous factory values (10 s and 5 s) take the new ones. Values an
-- operator changed stay. Idempotent: a second run matches no rows.
UPDATE css_config_variables SET value = '2' WHERE key = 'OCPPCommCtrlr.RetryBackOffWaitMinimum' AND value = '10';
--> statement-breakpoint
UPDATE css_config_variables SET value = '15' WHERE key = 'OCPPCommCtrlr.RetryBackOffRandomRange' AND value = '5';
