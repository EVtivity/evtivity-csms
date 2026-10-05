-- Hosts notification webhooks may reach even though they are, or resolve to,
-- private or internal addresses (the SSRF guard blocks those by default).
-- Empty by default; an operator adds a host, for example an in-house
-- automation server, from Settings > Notifications > Webhooks.

INSERT INTO settings (key, value) VALUES ('notifications.webhookAllowedPrivateHosts', '[]'::jsonb) ON CONFLICT (key) DO NOTHING;
