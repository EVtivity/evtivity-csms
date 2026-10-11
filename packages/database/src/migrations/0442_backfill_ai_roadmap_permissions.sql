-- AI roadmap v0.1.44 permissions (plan 2026-10-10, sections 3.10, 5.9, 6.6,
-- 7.1): automatic insights, the AI Inbox proposals, AI usage, and MCP access
-- for API keys. Backfill the role defaults of permissions.ts: operators get
-- every one of them; viewers read insights and proposals only (no usage, no
-- MCP). Admins are synced by sync-admin-permissions.ts after every migrate.
-- Idempotent.
INSERT INTO user_permissions (user_id, permission)
SELECT u.id, p.perm
FROM users u
JOIN roles r ON r.id = u.role_id
CROSS JOIN (
  VALUES
    ('aiInsights:read'),
    ('aiInsights:write'),
    ('aiProposals:read'),
    ('aiProposals:write'),
    ('aiUsage:read'),
    ('aiMcp:read'),
    ('aiMcp:write')
) AS p(perm)
WHERE r.name = 'operator'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO user_permissions (user_id, permission)
SELECT u.id, p.perm
FROM users u
JOIN roles r ON r.id = u.role_id
CROSS JOIN (VALUES ('aiInsights:read'), ('aiProposals:read')) AS p(perm)
WHERE r.name = 'viewer'
ON CONFLICT DO NOTHING;
