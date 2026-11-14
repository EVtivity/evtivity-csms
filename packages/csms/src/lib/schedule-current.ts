// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';

/** The current marks of a pricing schedule row (GET /v1/pricing-groups/:id/schedule). */
export interface ScheduleCurrent {
  isCurrent: boolean;
  /** The charging kinds the tariff is the active one for now. */
  currentFor?: Array<'ac' | 'dc'> | undefined;
}

/**
 * The badge text of a current schedule row: "Currently active" when it is
 * active for every kind (or the kind is not known), else the one kind it is
 * active for.
 */
export function scheduleCurrentLabel(item: ScheduleCurrent, t: TFunction): string | null {
  if (!item.isCurrent) return null;
  const kinds = item.currentFor ?? [];
  if (kinds.length !== 1) return t('pricing.isCurrent');
  return t('pricing.isCurrentForKind', {
    kind: t(kinds[0] === 'ac' ? 'pricing.chargingTypeAc' : 'pricing.chargingTypeDc'),
  });
}
