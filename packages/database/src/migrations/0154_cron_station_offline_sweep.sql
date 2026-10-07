INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'station-offline-sweep', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'station-offline-sweep');
