// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isRoamingEnabled } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const logger = createLogger('ocpi-tariff-push');

/** A published OCPI tariff id for one partner, or every partner (null). */
export interface OcpiTariffPushTarget {
  partnerId: string | null;
  ocpiTariffId: string;
}

/**
 * Asks the OCPI server to push published tariffs again (`ocpi_push`, type
 * `tariff`). Either the mapping targets that changed (each is pushed again, or
 * deleted at the partner when no mapping publishes it any more), or the
 * internal tariff or pricing group that changed (every mapping generated from
 * it is pushed). Neither (a holiday change) pushes every mapping.
 *
 * Fail-open: the mutation already committed, and partners still get the
 * current tariffs on their next GET /cpo/tariffs pull.
 */
export async function publishOcpiTariffPush(change: {
  targets?: OcpiTariffPushTarget[];
  tariffId?: string | null;
  pricingGroupId?: string | null;
}): Promise<void> {
  try {
    if (!(await isRoamingEnabled())) return;
    await getPubSub().publish('ocpi_push', JSON.stringify({ type: 'tariff', ...change }));
  } catch (err) {
    logger.warn({ err }, 'OCPI tariff push publish failed; partners get it on their next pull');
  }
}
