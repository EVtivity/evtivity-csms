-- AI roadmap v0.1.44 settings (plan 2026-10-10, sections 2.2, 3.10, 5.9,
-- 6.6, 7.1): the opsAi surface of system-initiated runs, automatic insights,
-- background workers, the MCP server, and the monthly and site token budgets.
-- System-initiated AI, every worker job and MCP start off (decision D4).
-- Values match defaultSettings in seed.ts and AI_SETTING_DEFAULTS in
-- @evtivity/lib/ai-config. ON CONFLICT DO NOTHING keeps an operator value;
-- idempotent.

INSERT INTO "settings" ("key", "value") VALUES
  ('opsAi.enabled', 'false'::jsonb),
  ('opsAi.provider', '"anthropic"'::jsonb),
  ('opsAi.model', '""'::jsonb),
  ('opsAi.effort', '"low"'::jsonb),
  ('opsAi.systemPrompt', '""'::jsonb),
  ('aiInsights.station.enabled', 'true'::jsonb),
  ('aiInsights.session.enabled', 'true'::jsonb),
  ('aiInsights.authorization.enabled', 'true'::jsonb),
  ('aiInsights.debounceSeconds', '120'::jsonb),
  ('aiInsights.cooldownMinutes', '60'::jsonb),
  ('aiInsights.siteIncidentThreshold', '3'::jsonb),
  ('aiInsights.maxPerSitePerDay', '50'::jsonb),
  ('aiInsights.primaryLanguage', '"en"'::jsonb),
  ('aiInsights.retentionDays', '90'::jsonb),
  ('aiWorkers.networkSummary.enabled', 'false'::jsonb),
  ('aiWorkers.stuckSessions.enabled', 'false'::jsonb),
  ('aiWorkers.stuckSessions.idleMinutes', '90'::jsonb),
  ('aiWorkers.stuckSessions.useModel', 'false'::jsonb),
  ('aiWorkers.tariffAnomalies.enabled', 'false'::jsonb),
  ('aiWorkers.proposalTtlHours', '24'::jsonb),
  ('ai.mcp.enabled', 'false'::jsonb),
  ('ai.mcp.rateLimitPerMinute', '60'::jsonb),
  ('ai.mcp.dailyCallsPerKey', '5000'::jsonb),
  ('ai.mcp.proposalTtlMinutes', '30'::jsonb),
  ('ai.mcp.allowedOrigins', '[]'::jsonb),
  ('ai.budget.companyMonthlyTokens', '0'::jsonb),
  ('ai.budget.siteMonthlyTokens', '0'::jsonb),
  ('ai.budget.siteDailyTokens', '300000'::jsonb),
  ('ai.budget.warnPercent', '80'::jsonb)
ON CONFLICT ("key") DO NOTHING;
