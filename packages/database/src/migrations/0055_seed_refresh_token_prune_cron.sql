-- Daily cleanup of refresh_tokens rows. The rotation path inserts a new
-- row on every access-token refresh and revokes the previous one, so a
-- single long-lived account contributes one row per refresh forever.
-- Without this prune the table grows unbounded; the tokenHash lookup stays
-- O(log n) via the index but vacuum, backup, and replica lag all suffer.

INSERT INTO settings (key, value, updated_at)
SELECT 'refreshTokens.retentionDays', '30'::jsonb, NOW()
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'refreshTokens.retentionDays');

INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'refresh-token-prune', '45 4 * * *', 'pending', NOW() + INTERVAL '1 day'
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'refresh-token-prune');
