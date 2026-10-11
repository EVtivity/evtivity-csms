-- Driver AI support (plan v0.1.45, section 2.4): every minute, queue again
-- cases stuck in queued or analyzing, and escalate cases whose driver did not
-- answer the feedback question in time. Idempotent.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'driver-ai-sweep', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'driver-ai-sweep');
