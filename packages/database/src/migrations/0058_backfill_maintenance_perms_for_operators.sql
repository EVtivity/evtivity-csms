-- Backfill maintenance:read and maintenance:write for every existing operator
-- user. Admins are handled automatically by sync-admin-permissions.ts which
-- runs after every drizzle-kit migrate. See `.claude/rules/api/permission-sync.md`.

INSERT INTO user_permissions (user_id, permission)
SELECT u.id, p.perm
FROM users u
JOIN roles r ON r.id = u.role_id
CROSS JOIN (VALUES ('maintenance:read'), ('maintenance:write')) AS p(perm)
WHERE r.name = 'operator'
ON CONFLICT DO NOTHING;
