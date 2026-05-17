-- Every credential setting uses the `Enc` suffix so the runtime knows to
-- encrypt it at rest. These four keys held real secrets but were stored
-- plaintext under suffix-less names. Rename to the `Enc` form and clear the
-- value -- operators re-enter via the Settings UI, which encrypts on save.
-- Wiping rather than carrying plaintext forward keeps the encryption
-- contract honest: every byte in an *Enc column is ciphertext, no
-- exceptions, no startup-fixup hook.
UPDATE settings SET key = 'smtp.passwordEnc', value = '""' WHERE key = 'smtp.password';
UPDATE settings SET key = 'twilio.authTokenEnc', value = '""' WHERE key = 'twilio.authToken';
UPDATE settings SET key = 'ftp.passwordEnc', value = '""' WHERE key = 'ftp.password';
UPDATE settings SET key = 'googleMaps.apiKeyEnc', value = '""' WHERE key = 'googleMaps.apiKey';
