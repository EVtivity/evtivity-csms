// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import type postgres from 'postgres';
import { listPricingGroupsWithoutDefault } from '@evtivity/database';

/**
 * Logs every pricing group with active tariffs but no active default tariff
 * without restrictions (owner decision 2026-10-09: a startup report). Such a
 * group bills nothing of its own when none of its tariffs matches; the
 * resolver passes to the next pricing group. Fail-open (P9): a failed check is
 * logged at warn and the API starts.
 */
export async function reportPricingGroupsWithoutDefault(
  sql: postgres.Sql,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<number> {
  try {
    const groups = await listPricingGroupsWithoutDefault(sql);
    for (const group of groups) {
      log.warn(
        { pricingGroupId: group.id, pricingGroupName: group.name },
        'Pricing group has tariffs but no active default tariff without restrictions; add one. Until then a time or energy no tariff of the group matches is priced by the next pricing group.',
      );
    }
    return groups.length;
  } catch (err) {
    log.warn({ err }, 'Pricing group default check failed; continuing');
    return 0;
  }
}
