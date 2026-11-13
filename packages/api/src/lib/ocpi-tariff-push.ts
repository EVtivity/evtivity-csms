// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isRoamingEnabled } from '@evtivity/database';
import {
  createLogger,
  OCPI_KIND_TARIFF_BASE_ID_MAX,
  OCPI_TARIFF_SETTING_KEYS,
  ocpiKindTariffId,
} from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const logger = createLogger('ocpi-tariff-push');

/** A published OCPI tariff id for one partner, or every partner (null). */
export interface OcpiTariffPushTarget {
  partnerId: string | null;
  ocpiTariffId: string;
}

/**
 * The push targets of a pricing group mapping: its own id and the per-kind
 * ids (`<id>-AC`, `<id>-DC`, owner decision D-C), so a group that publishes
 * per charging kind, or stops doing so, gets every id it publishes pushed and
 * every id it no longer publishes deleted at the partner.
 */
export function groupMappingTargets(target: OcpiTariffPushTarget): OcpiTariffPushTarget[] {
  if (target.ocpiTariffId.length > OCPI_KIND_TARIFF_BASE_ID_MAX) return [target];
  return [
    target,
    { ...target, ocpiTariffId: ocpiKindTariffId(target.ocpiTariffId, 'ac') },
    { ...target, ocpiTariffId: ocpiKindTariffId(target.ocpiTariffId, 'dc') },
  ];
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
  /** A setting every tariff is rendered with changed: every mapping is pushed. */
  settingsChanged?: boolean;
}): Promise<void> {
  try {
    if (!(await isRoamingEnabled())) return;
    await getPubSub().publish('ocpi_push', JSON.stringify({ type: 'tariff', ...change }));
  } catch (err) {
    logger.warn({ err }, 'OCPI tariff push publish failed; partners get it on their next pull');
  }
}

/**
 * Pushes every published tariff again after a change to a setting they are
 * all rendered with (currency, tax basis, idle grace). Unchanged values push
 * nothing.
 */
export async function publishOcpiTariffSettingChange(
  key: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  if (!(OCPI_TARIFF_SETTING_KEYS as readonly string[]).includes(key)) return;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await publishOcpiTariffPush({ settingsChanged: true });
}
