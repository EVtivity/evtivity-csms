// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';

// Daily cron: deletes mfa_challenges rows that have expired or have been
// consumed. Rows are short-lived (5-minute TTL on creation), and the verify
// path soft-deletes consumed ones by setting used_at. Without periodic
// pruning the table grows by one row per login MFA challenge forever; on
// a fleet with many MFA-enabled operators that adds up quickly.
export async function mfaChallengePruneHandler(log: Logger): Promise<void> {
  const result = await client`
    DELETE FROM mfa_challenges
    WHERE expires_at < NOW() OR used_at IS NOT NULL
  `;
  log.info({ deleted: result.count }, 'mfa-challenge-prune: completed');
}
