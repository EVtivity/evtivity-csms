// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';

// Daily cron: deletes expired station_watches rows. Watches are one-shot
// (claimed by the dispatch DELETE when they fire) and otherwise auto-expire
// after 24h, but an unfired watch that simply ages out is never deleted by the
// fire path. Without this prune the table grows by one row per expired watch
// forever, which slows the available-edge watcher lookup and the dispatch claim.
export async function stationWatchPruneHandler(log: Logger): Promise<void> {
  const result = await client`
    DELETE FROM station_watches WHERE expires_at < NOW()
  `;
  log.info({ deleted: result.count }, 'station-watch-prune: completed');
}
