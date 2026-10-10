// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TariffRestrictions } from './tariff-restrictions.js';
import { derivePriority } from './tariff-restrictions.js';

/** A tariff of a pricing group, as the default rule reads it. */
export interface GroupDefaultTariff {
  id: string;
  restrictions: TariffRestrictions | null;
  isDefault: boolean;
  isActive: boolean;
}

export type GroupDefaultCheck =
  | { valid: true }
  | {
      valid: false;
      /**
       * `no_default`: the group has active tariffs but no active default.
       * `restricted_default`: a tariff with restrictions is marked default.
       * `multiple_defaults`: more than one tariff is marked default.
       */
      reason: 'no_default' | 'restricted_default' | 'multiple_defaults';
      tariffId?: string;
    };

/** True when the tariff applies at any time (no restrictions, priority 0). */
export function isUnrestrictedTariff(restrictions: TariffRestrictions | null): boolean {
  return derivePriority(restrictions) === 0;
}

/**
 * The default rule of a pricing group (owner decision 2026-10-09): a group
 * with active tariffs has exactly one active default tariff, and that tariff
 * has no restrictions, so every time and energy matches a tariff of the
 * group. A group without active tariffs needs no default (the resolver goes
 * on to the next group). `tariffs` is the group after the change.
 */
export function checkGroupDefault(tariffs: GroupDefaultTariff[]): GroupDefaultCheck {
  const defaults = tariffs.filter((t) => t.isDefault);
  const restricted = defaults.find((t) => !isUnrestrictedTariff(t.restrictions));
  if (restricted != null) {
    return { valid: false, reason: 'restricted_default', tariffId: restricted.id };
  }
  const second = defaults[1];
  if (second != null) {
    return { valid: false, reason: 'multiple_defaults', tariffId: second.id };
  }
  const active = tariffs.filter((t) => t.isActive);
  if (active.length === 0) return { valid: true };
  if (!active.some((t) => t.isDefault)) return { valid: false, reason: 'no_default' };
  return { valid: true };
}
