-- Minute scan of the projection tables for automatic insights (roadmap
-- v0.1.44, decision D3). It does nothing while opsAi.enabled is off.
-- Idempotent.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ai-insight-scan', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ai-insight-scan');
