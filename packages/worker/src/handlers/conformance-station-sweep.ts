// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import {
  db,
  octtRuns,
  conformanceTestDriverInUse,
  deleteConformanceStations,
  deleteConformanceTestDriver,
} from '@evtivity/database';
import { createRedisClient } from '@evtivity/lib';
import { restoreLeftoverRunSettings } from '@evtivity/octt';
import { OCTT_RUN_LOCK_KEY } from './octt-runner.js';

/**
 * A CSMS-run conformance station offline with no activity for this long
 * belongs to no running test: a test lasts minutes, and a CLI run (which
 * holds no run lock) deletes its stations at its end.
 */
export const CONFORMANCE_SWEEP_IDLE_MS = 30 * 60_000;

/**
 * Age after which a CS runner station (`OCTT-CS-*`) is swept. The CS runner
 * deletes each test's station when the test ends, and a CS test never runs
 * this long, so an older one is a leftover of a CS run that stopped. Younger
 * ones may belong to a CS run still going and are never touched.
 */
export const CONFORMANCE_SWEEP_CS_AGE_MS = 6 * 60 * 60_000;

export interface ConformanceSweepDeps {
  /** Whether a worker conformance run holds the run lock. */
  runLockHeld: () => Promise<boolean>;
  now: () => Date;
  /**
   * Puts back the settings a killed CSMS run left changed, when its run last
   * refreshed them before `staleBefore`. Returns how many it restored.
   */
  restoreLeftoverSettings: (staleBefore: Date) => Promise<number>;
}

export interface ConformanceSweepResult {
  skipped: boolean;
  crashedRuns: number;
  stationsDeleted: number;
  driverDeleted: boolean;
  settingsRestored: number;
}

/**
 * Removes what conformance runs that are no longer running left behind: a
 * run whose worker crashed, a failed cleanup, a CLI run that was killed.
 * While a worker run holds the run lock nothing is touched (that run deletes
 * its own data at its end). Otherwise a run still marked running crashed and
 * is marked failed, settings a killed run left changed are restored, idle
 * conformance stations are deleted, and the test driver once no run can be
 * using it.
 */
export async function sweepConformanceStations(
  log: Logger,
  deps: ConformanceSweepDeps,
): Promise<ConformanceSweepResult> {
  const result: ConformanceSweepResult = {
    skipped: false,
    crashedRuns: 0,
    stationsDeleted: 0,
    driverDeleted: false,
    settingsRestored: 0,
  };
  if (await deps.runLockHeld()) {
    result.skipped = true;
    return result;
  }
  const now = deps.now().getTime();

  // The worker sets `running` only while it holds the lock (octt-runner.ts),
  // so a run still marked running without the lock lost its worker.
  const crashed = await db
    .update(octtRuns)
    .set({ status: 'failed', completedAt: new Date(now) })
    .where(eq(octtRuns.status, 'running'))
    .returning({ id: octtRuns.id });
  result.crashedRuns = crashed.length;

  const idleBefore = new Date(now - CONFORMANCE_SWEEP_IDLE_MS);
  // A run refreshes its pending restore row every few minutes, a CLI run too.
  result.settingsRestored = await deps.restoreLeftoverSettings(idleBefore);

  result.stationsDeleted = await deleteConformanceStations({
    includeCs: true,
    idleBefore,
    csCreatedBefore: new Date(now - CONFORMANCE_SWEEP_CS_AGE_MS),
  });

  if (!(await conformanceTestDriverInUse(idleBefore))) {
    const driver = await deleteConformanceTestDriver();
    result.driverDeleted = driver.driverDeleted;
    if (driver.detachedRows > 0 || driver.pricingGroupsKept > 0) {
      log.warn(driver, 'Conformance test driver deleted; rows outside the run referenced it');
    }
  }

  if (
    result.crashedRuns > 0 ||
    result.stationsDeleted > 0 ||
    result.driverDeleted ||
    result.settingsRestored > 0
  ) {
    log.info(result, 'Conformance leftovers removed');
  }
  return result;
}

let redis: Redis | null = null;

function lockStore(): Redis {
  if (redis == null) {
    redis = createRedisClient(
      process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      'conformance-station-sweep',
      { maxRetriesPerRequest: 2 },
    );
  }
  return redis;
}

export async function conformanceStationSweepHandler(log: Logger): Promise<void> {
  await sweepConformanceStations(log, {
    runLockHeld: async () => (await lockStore().exists(OCTT_RUN_LOCK_KEY)) === 1,
    now: () => new Date(),
    restoreLeftoverSettings: async (staleBefore) =>
      (await restoreLeftoverRunSettings(log, { staleBefore })).length,
  });
}
