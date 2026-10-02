-- Hosts the CSMS may contact for OCSP even though they are private or
-- internal addresses (the SSRF guard blocks those by default). Empty by
-- default; an operator adds a host, for example an in-house OCSP responder or
-- a conformance test system, from Settings > Plug & Charge.

INSERT INTO settings (key, value) VALUES ('pnc.ocsp.allowedPrivateHosts', '[]'::jsonb) ON CONFLICT (key) DO NOTHING;
