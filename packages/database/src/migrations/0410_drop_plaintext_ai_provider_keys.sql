-- An AI provider key is stored only under ai.<provider>.apiKeyEnc, encrypted
-- at rest. A seed that did not map the seed.config.json name
-- ai.<provider>.apiKey wrote the key as a plaintext row under that name,
-- which nothing reads. SQL cannot encrypt it (the key lives in
-- SETTINGS_ENCRYPTION_KEY), so delete it: the operator enters the key again
-- in Settings or reruns the seed. Idempotent.
DO $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM settings WHERE key ~ '^ai\.[A-Za-z0-9_-]+\.apiKey$';
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed > 0 THEN
    RAISE NOTICE 'Deleted % plaintext AI provider key setting(s). Enter the keys again in Settings.', removed;
  END IF;
END $$;
