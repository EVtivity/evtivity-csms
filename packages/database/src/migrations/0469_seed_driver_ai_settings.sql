-- v0.1.45 settings (plan 2026-10-11, sections 2.14 and 4.6): the driverAi
-- surface of driver support analyses with its per-driver limits, and the
-- reservation insight switch. Driver support starts off (decision E7).
-- Values match defaultSettings in seed.ts and AI_SETTING_DEFAULTS in
-- @evtivity/lib/ai-config. ON CONFLICT DO NOTHING keeps an operator value;
-- idempotent.

INSERT INTO "settings" ("key", "value") VALUES
  ('driverAi.enabled', 'false'::jsonb),
  ('driverAi.provider', '"anthropic"'::jsonb),
  ('driverAi.model', '""'::jsonb),
  ('driverAi.effort', '"low"'::jsonb),
  ('driverAi.systemPrompt', '""'::jsonb),
  ('driverAi.maxCasesPerDriverPerDay', '3'::jsonb),
  ('driverAi.feedbackTimeoutHours', '24'::jsonb),
  ('ai.budget.driverDailyTokens', '40000'::jsonb),
  ('ai.rateLimit.driverPerMinute', '2'::jsonb),
  ('aiInsights.reservation.enabled', 'true'::jsonb)
ON CONFLICT ("key") DO NOTHING;
