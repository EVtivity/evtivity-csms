-- Mobile device attestation settings. Disabled by default; native portal
-- clients keep relying on the endpoint rate limit until an operator fills in
-- the iOS App Attest / Android Play Integrity credentials and flips enabled on.
-- The service account is an Enc key (encrypted at rest by the settings layer).

INSERT INTO settings (key, value) VALUES ('attestation.enabled', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('attestation.ios.teamId', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('attestation.ios.bundleId', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('attestation.ios.environment', '"development"'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('attestation.android.cloudProjectNumber', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('attestation.android.packageName', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('attestation.android.serviceAccountEnc', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
