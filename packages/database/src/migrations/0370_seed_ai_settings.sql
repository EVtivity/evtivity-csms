-- AI settings of the provider-agnostic assistant (plan 2026-10-09, section 3.4):
-- one credential set per provider, an effort level per surface, and the AI
-- limits. Values match defaultSettings in seed.ts. Idempotent.
INSERT INTO settings (key, value) VALUES
  ('ai.anthropic.apiKeyEnc', '""'),
  ('ai.anthropic.baseUrl', '""'),
  ('ai.openai.apiKeyEnc', '""'),
  ('ai.openai.baseUrl', '""'),
  ('ai.gemini.apiKeyEnc', '""'),
  ('ai.gemini.baseUrl', '""'),
  ('ai.deepseek.apiKeyEnc', '""'),
  ('ai.deepseek.baseUrl', '""'),
  ('ai.rateLimit.userPerMinute', '10'),
  ('ai.rateLimit.sitePerMinute', '60'),
  ('ai.budget.userDailyTokens', '2000000'),
  ('ai.maxToolCallsPerTurn', '20'),
  ('ai.conversationRetentionDays', '30'),
  ('ai.attachments.maxBytes', '10485760'),
  ('ai.attachments.maxPerMessage', '5'),
  ('chatbotAi.effort', '"medium"'),
  ('supportAi.effort', '"medium"')
ON CONFLICT (key) DO NOTHING;
