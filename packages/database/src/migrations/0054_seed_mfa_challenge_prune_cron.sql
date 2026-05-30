-- Daily cleanup of mfa_challenges rows. The verify path soft-deletes
-- consumed rows by setting used_at; expired rows linger. Without this
-- prune the table grows by one row per MFA login forever.

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'mfa-challenge-prune', '15 4 * * *', 'pending', NOW() + INTERVAL '1 day'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'mfa-challenge-prune');
