INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'ocpi-location-sync', '0 3,15 * * *', 'pending', NOW() + INTERVAL '1 hour'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'ocpi-location-sync');
