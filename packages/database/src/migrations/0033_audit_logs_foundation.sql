-- Audit logs foundation: shared actor enum, retention setting, RBAC
-- permissions, and the worker cron row. Per-entity audit tables and their
-- per-entity action enums live in 0034_audit_logs_entity_tables.sql.

DO $$ BEGIN
  CREATE TYPE audit_actor AS ENUM (
    'operator',
    'driver',
    'api_key',
    'system',
    'ocpp'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO settings (key, value)
VALUES ('audit.retentionDays', '1095'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO user_permissions (user_id, permission)
SELECT u.id, p.perm
FROM users u
CROSS JOIN (VALUES ('audit:read'), ('audit:write')) AS p(perm)
JOIN roles r ON r.id = u.role_id
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO user_permissions (user_id, permission)
SELECT u.id, 'audit:read'
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE r.name = 'operator'
ON CONFLICT DO NOTHING;

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'audit-retention-prune', '0 3 * * *', 'pending', NOW() + INTERVAL '1 day'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'audit-retention-prune');
