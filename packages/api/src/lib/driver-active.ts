// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, drivers } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/**
 * Whether the driver exists and is active. Read on every driver request
 * (`driverTokenRejection`), uncached, so a deactivation applies to the next
 * request at once.
 */
export async function isDriverActive(driverId: string): Promise<boolean> {
  const [row] = await db
    .select({ isActive: drivers.isActive })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  return row?.isActive === true;
}

/**
 * Announces a driver deactivation on `cache_invalidate` (`{ kind:
 * 'driver_active', driverId }`). Every API pod, the publishing one included,
 * ends the driver's open portal event streams (`closeDriverEventStreams`); a
 * reconnect is refused by `driverTokenRejection`. A failed publish is logged
 * at warn: the streams then end at the token expiry (P9).
 */
export function announceDriverDeactivated(driverId: string): void {
  void getPubSub()
    .publish('cache_invalidate', JSON.stringify({ kind: 'driver_active', driverId }))
    .catch((err: unknown) => {
      // fail-open: open streams end at the token expiry instead (P9).
      createLogger('driver-active').warn(
        { err, driverId },
        'cache_invalidate publish for driver status failed',
      );
    });
}
