INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'process-version-watch', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'process-version-watch');
