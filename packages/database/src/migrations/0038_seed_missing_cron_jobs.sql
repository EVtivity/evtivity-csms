-- Backfill cronjobs rows for worker handlers that were registered in
-- packages/worker/src/cron-worker.ts but never received a database row.
-- Without these rows, the scheduler never picks up the handlers, so the
-- features they support (scheduled reports, payment reconciliation,
-- charging-profile drift detection, config drift detection, stale-session
-- cleanup) silently never run.
--
-- Earlier migrations (0001, 0006, 0011, 0019, 0033, 0037) seeded some
-- cronjobs rows individually but left these gaps. This migration adds
-- the missing rows idempotently so re-runs and partial-state databases
-- both end up correct.

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'report-scheduler', '*/5 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'report-scheduler');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'payment-reconciliation', '0 4 * * *', 'pending', NOW() + INTERVAL '1 day'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'payment-reconciliation');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'charging-profile-reconciliation', '0 */6 * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'charging-profile-reconciliation');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'config-drift-detection', '0 */6 * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'config-drift-detection');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'stale-session-cleanup', '*/15 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'stale-session-cleanup');

-- Re-seed the rows from older migrations that were never re-inserted
-- after schema resets in some deployments.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'tariff-boundary-check', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'tariff-boundary-check');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'guest-session-cleanup', '*/5 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'guest-session-cleanup');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'reservation-expiry-check', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'reservation-expiry-check');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'offline-command-cleanup', '*/5 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'offline-command-cleanup');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'certificate-expiration-check', '0 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'certificate-expiration-check');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'station-message-charging-refresh', '*/30 * * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'station-message-charging-refresh');
