-- Hourly prune of AI chat attachments (deleted, owner removed, or never used
-- in a message within a day). Idempotent.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ai-retention-prune', '40 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ai-retention-prune');
