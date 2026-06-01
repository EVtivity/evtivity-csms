-- Seed the default maintenance message template setting + register the
-- maintenance-scheduler cron. The scheduler runs every minute to activate
-- due events and end active ones whose planned_end_at has passed.
-- See `.claude/rules/features/maintenance-mode.md`.

INSERT INTO settings (key, value)
VALUES (
  'maintenance.defaultMessageTemplate',
  '"This site is temporarily unavailable for maintenance until {{endTime}}. {{reason}}"'::jsonb
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'maintenance-scheduler', '* * * * *', 'pending', NOW() + INTERVAL '1 minute'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'maintenance-scheduler');
