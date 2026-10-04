INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'payout-account-sync', '0 5 * * *', 'pending', NOW() + INTERVAL '1 hour'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'payout-account-sync');
