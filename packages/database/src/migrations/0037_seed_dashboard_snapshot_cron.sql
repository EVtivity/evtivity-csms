-- Seed the dashboard-snapshot cron row. The handler is registered in
-- packages/worker/src/cron-worker.ts but the cronjobs row was never
-- created, so the daily snapshot never ran in any deployment. Without
-- it, the dashboard's Historical and Trend modes have no data.
--
-- Schedule: 01:00 UTC daily. The handler computes "yesterday" in each
-- site's local timezone, so 01:00 UTC catches yesterday across the
-- US-Pacific to US-Eastern range cleanly and is just past midnight in
-- most of Europe.

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'dashboard-snapshot', '0 1 * * *', 'pending', NOW() + INTERVAL '1 day'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'dashboard-snapshot');
