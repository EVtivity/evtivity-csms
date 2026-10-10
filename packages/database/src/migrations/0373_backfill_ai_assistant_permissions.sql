-- Chatting with the AI assistant gets its own permission, aiAssistant:read
-- and aiAssistant:write, instead of settings.ai:write. Backfill the role
-- defaults (operator read and write, viewer read) and both permissions for
-- every user who could chat before (holds settings.ai:write), so nobody loses
-- access on upgrade. Admins are synced by sync-admin-permissions.ts after
-- every migrate. Idempotent.
INSERT INTO user_permissions (user_id, permission)
SELECT u.id, p.perm
FROM users u
JOIN roles r ON r.id = u.role_id
CROSS JOIN (VALUES ('aiAssistant:read'), ('aiAssistant:write')) AS p(perm)
WHERE r.name = 'operator'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO user_permissions (user_id, permission)
SELECT u.id, 'aiAssistant:read'
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE r.name = 'viewer'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO user_permissions (user_id, permission)
SELECT up.user_id, p.perm
FROM user_permissions up
CROSS JOIN (VALUES ('aiAssistant:read'), ('aiAssistant:write')) AS p(perm)
WHERE up.permission = 'settings.ai:write'
ON CONFLICT DO NOTHING;
