// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { recordProcessWatch } from '@evtivity/payments';
import { createRedisClient } from '@evtivity/lib';

let redis: Redis | null = null;

function watchStore(): Redis {
  if (redis == null) {
    redis = createRedisClient(
      process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      'process-version-watch',
      { maxRetriesPerRequest: 2 },
    );
  }
  return redis;
}

/**
 * Every minute: counts the database connections of processes older than
 * v0.1.38 and records the result in Redis (Payments P10, provider-switch
 * guard). Selecting Adyen needs a recent result that saw no old process for
 * 10 minutes. A failure is logged at warn and the next run retries; while
 * the result is stale the guard refuses the switch (fail closed).
 */
export async function processVersionWatchHandler(log: Logger): Promise<void> {
  try {
    const { check } = await recordProcessWatch(watchStore());
    if (check.legacy > 0) {
      log.info(
        { legacyConnections: check.legacy, hosts: check.hosts },
        'Processes older than v0.1.38 are connected to the database',
      );
    } else {
      log.debug('No process older than v0.1.38 is connected');
    }
  } catch (err) {
    log.warn(
      { err },
      'Process version watch failed: selecting Adyen stays refused until a run succeeds',
    );
  }
}
