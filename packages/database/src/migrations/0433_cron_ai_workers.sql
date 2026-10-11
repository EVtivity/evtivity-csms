-- Background AI worker cron rows. Each job does nothing until its
-- aiWorkers.* switch and opsAi.enabled are on (both default off). The sweep
-- expires proposals past their TTL; the digest sends the opt-in daily email.
-- Idempotent.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ai-network-summary', '30 5 * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ai-network-summary');--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ai-stuck-sessions', '*/15 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ai-stuck-sessions');--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ai-tariff-anomalies', '0 6 * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ai-tariff-anomalies');--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ai-proposal-sweep', '*/5 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ai-proposal-sweep');--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ai-proposal-digest', '0 7 * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ai-proposal-digest');
