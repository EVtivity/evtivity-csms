// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, ocpiPartners, isRoamingEnabled } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';

// Twice-daily reconciliation: refresh the cached partner location catalog so the
// portal/mobile roaming search keeps discovering out-of-network stations even
// when a partner does not push location updates. The actual pull runs in the
// OCPI server (under its per-partner lock); this only publishes the trigger per
// connected partner. No-ops when roaming is disabled so the cronjob row can stay
// seeded unconditionally.
export async function ocpiLocationSyncHandler(log: Logger): Promise<void> {
  if (!(await isRoamingEnabled())) {
    log.debug('OCPI roaming disabled; skipping scheduled location sync');
    return;
  }

  const partners = await db
    .select({ id: ocpiPartners.id })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.status, 'connected'));
  if (partners.length === 0) {
    return;
  }

  const pubsub = getPubSub();
  let published = 0;
  for (const partner of partners) {
    try {
      await pubsub.publish(
        'ocpi_sync',
        JSON.stringify({ partnerId: partner.id, module: 'locations' }),
      );
      published++;
    } catch (err) {
      log.warn({ err, partnerId: partner.id }, 'Failed to publish scheduled ocpi_sync');
    }
  }

  log.info({ partners: partners.length, published }, 'Scheduled OCPI location sync dispatched');
}
