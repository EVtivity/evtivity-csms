// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';

// Daily cron: deletes refresh_tokens rows that have been revoked or have
// passed their expiresAt. The rotation path inserts a new row on every
// access-token refresh and revokes the previous one, so a single long-lived
// account contributes one row per refresh forever. With session JWTs
// expiring at 1h, that's roughly 24 dead rows per active user per day.
// Without pruning the table grows unbounded -- the tokenHash lookup stays
// O(log n) via the index but vacuum, backup, and replica lag all suffer.
//
// Retention defaults to 30 days so a fraud investigation has a window to
// trace a revoked token back to its issuance audit trail before the row
// is gone. Operators can tune via the refreshTokens.retentionDays setting.
export async function refreshTokenPruneHandler(log: Logger): Promise<void> {
  const settingRows = await client`
    SELECT value FROM settings WHERE key = 'refreshTokens.retentionDays'
  `;
  const setting = settingRows[0] as { value: unknown } | undefined;
  const retentionDays =
    typeof setting?.value === 'number'
      ? setting.value
      : typeof setting?.value === 'string'
        ? Number.parseInt(setting.value, 10)
        : 30;

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    log.info({ retentionDays }, 'refresh-token-prune: disabled');
    return;
  }

  const result = await client`
    DELETE FROM refresh_tokens
    WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - (${retentionDays}::int * INTERVAL '1 day'))
       OR (expires_at IS NOT NULL AND expires_at < NOW() - (${retentionDays}::int * INTERVAL '1 day'))
  `;
  log.info({ deleted: result.count, retentionDays }, 'refresh-token-prune: completed');
}
