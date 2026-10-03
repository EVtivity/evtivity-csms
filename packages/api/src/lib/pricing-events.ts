// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from '@evtivity/lib';
import { getPubSub } from './pubsub.js';
import { publishOcpiTariffPush } from './ocpi-tariff-push.js';

const logger = createLogger('pricing-events');

/**
 * Changes that alter what a published OCPI tariff contains: prices, tax,
 * restrictions, or holidays. Creating an empty group or changing assignments
 * does not. Deleting a group deletes its mappings (FK cascade); partners drop
 * those tariffs on their next GET /cpo/tariffs pull.
 */
const OCPI_TARIFF_ACTIONS: ReadonlySet<PricingChangedAction> = new Set<PricingChangedAction>([
  'group.updated',
  'tariff.created',
  'tariff.updated',
  'tariff.deleted',
  'holiday.changed',
]);

export type PricingChangedAction =
  | 'group.updated'
  | 'group.deleted'
  | 'tariff.updated'
  | 'tariff.deleted'
  | 'tariff.created'
  | 'group.created'
  | 'holiday.changed'
  | 'assignment.changed';

export async function publishPricingChanged(args: {
  pricingGroupId: string | null;
  tariffId?: string | null;
  action: PricingChangedAction;
  // Assignment events carry the entity context so the SSE hook can also
  // invalidate the relevant detail-page query (station/driver/fleet/site)
  // alongside the pricing-list queries.
  siteId?: string | null;
  stationId?: string | null;
  driverId?: string | null;
  fleetId?: string | null;
}): Promise<void> {
  try {
    const pubsub = getPubSub();
    await pubsub.publish(
      'csms_events',
      JSON.stringify({
        eventType: 'pricing.changed',
        pricingGroupId: args.pricingGroupId,
        tariffId: args.tariffId ?? null,
        action: args.action,
        siteId: args.siteId ?? null,
        stationId: args.stationId ?? null,
        driverId: args.driverId ?? null,
        fleetId: args.fleetId ?? null,
      }),
    );
  } catch (err) {
    // Non-critical: stale UI on missed invalidation, but the mutation
    // already committed and the audit log captured it.
    logger.warn({ err, action: args.action }, 'pricing.changed publish failed');
  }
  if (OCPI_TARIFF_ACTIONS.has(args.action)) {
    await publishOcpiTariffPush({
      tariffId: args.tariffId ?? null,
      pricingGroupId: args.pricingGroupId,
    });
  }
}
