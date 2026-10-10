-- One API key per AI provider (plan 2026-10-09, owner decision O3) and effort
-- instead of sampling (O2), in one step (P13).
--
-- Copies chatbotAi.apiKeyEnc to ai.<chatbotAi.provider>.apiKeyEnc, then
-- supportAi.apiKeyEnc to ai.<supportAi.provider>.apiKeyEnc, each only when the
-- target is empty. The value is copied as stored: encryptString uses no
-- associated data, so the ciphertext decrypts under its new key name and no
-- plaintext moves. When both surfaces use one provider, the chatbot key wins
-- and a NOTICE names the dropped key. A key whose surface has no known
-- provider is dropped with a NOTICE. Then the per-surface keys and the
-- sampling settings are deleted. Idempotent: a rerun finds no old keys.
DO $$
DECLARE
  surface text;
  provider text;
  key_value jsonb;
  target text;
  target_value jsonb;
BEGIN
  FOREACH surface IN ARRAY ARRAY['chatbotAi', 'supportAi'] LOOP
    SELECT value INTO key_value FROM settings WHERE key = surface || '.apiKeyEnc';
    IF key_value IS NULL OR jsonb_typeof(key_value) <> 'string' OR key_value #>> '{}' = '' THEN
      CONTINUE;
    END IF;

    SELECT value #>> '{}' INTO provider FROM settings WHERE key = surface || '.provider';
    IF provider IS NULL OR provider NOT IN ('anthropic', 'openai', 'gemini', 'deepseek') THEN
      RAISE NOTICE 'AI key move: %.apiKeyEnc dropped, %.provider is not a known provider (%). Enter the key again under Settings > AI.',
        surface, surface, coalesce(provider, 'unset');
      CONTINUE;
    END IF;

    target := 'ai.' || provider || '.apiKeyEnc';
    SELECT value INTO target_value FROM settings WHERE key = target;
    IF target_value IS NOT NULL AND jsonb_typeof(target_value) = 'string' AND target_value #>> '{}' <> '' THEN
      IF target_value <> key_value THEN
        RAISE NOTICE 'AI key move: %.apiKeyEnc dropped, % already holds a key. If it was a different key, enter it again under Settings > AI.',
          surface, target;
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO settings (key, value, updated_at) VALUES (target, key_value, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END LOOP;
END $$;
--> statement-breakpoint
DELETE FROM settings
WHERE key IN (
  'chatbotAi.apiKeyEnc',
  'chatbotAi.temperature',
  'chatbotAi.topP',
  'chatbotAi.topK',
  'supportAi.apiKeyEnc',
  'supportAi.temperature',
  'supportAi.topP',
  'supportAi.topK'
);
