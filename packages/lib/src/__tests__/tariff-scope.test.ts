// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  chargingKindsOf,
  isUnscopedTariff,
  tariffAppliesTo,
  tariffScopeDominates,
  tariffScopesConflict,
  tariffScopesOverlap,
  tariffSpecificity,
} from '../tariff-scope.js';
import type { TariffScope } from '../tariff-scope.js';
import { evseChargingKind } from '../connector-power.js';
import { compareTariffs, resolveActiveTariff } from '../tariff-resolver.js';
import type { TariffWithRestrictions } from '../tariff-resolver.js';
import { validateNoOverlap } from '../tariff-overlap.js';
import { checkGroupDefault, isDefaultCapableTariff } from '../tariff-default.js';

const BOTH_ALL: TariffScope = {};
const AC_ALL: TariffScope = { chargingType: 'ac' };
const DC_ALL: TariffScope = { chargingType: 'dc' };
const BOTH_A: TariffScope = { siteIds: ['site_a'] };
const AC_A: TariffScope = { chargingType: 'ac', siteIds: ['site_a'] };
const AC_AB: TariffScope = { chargingType: 'ac', siteIds: ['site_a', 'site_b'] };
const AC_BC: TariffScope = { chargingType: 'ac', siteIds: ['site_b', 'site_c'] };
const AC_C: TariffScope = { chargingType: 'ac', siteIds: ['site_c'] };
const NONE: TariffScope = { chargingType: 'ac', siteIds: [] };

describe('evseChargingKind', () => {
  it('reads an EVSE as AC, DC, mixed or unknown from its connectors', () => {
    expect(evseChargingKind([{ connectorType: 'Type2', maxPowerKw: 22 }])).toBe('ac');
    expect(evseChargingKind([{ connectorType: 'CCS2', maxPowerKw: 150 }])).toBe('dc');
    expect(
      evseChargingKind([
        { connectorType: 'CCS1', maxPowerKw: 150 },
        { connectorType: 'CHAdeMO', maxPowerKw: 50 },
      ]),
    ).toBe('dc');
    expect(
      evseChargingKind([
        { connectorType: 'Type2', maxPowerKw: 22 },
        { connectorType: 'CCS2', maxPowerKw: 50 },
      ]),
    ).toBe('mixed');
    expect(evseChargingKind([{ connectorType: 'NACS', maxPowerKw: 11.5 }])).toBe('ac');
    expect(evseChargingKind([{ connectorType: 'NACS', maxPowerKw: 250 }])).toBe('dc');
    expect(evseChargingKind([{ connectorType: 'MCS', maxPowerKw: null }])).toBe('dc');
    expect(evseChargingKind([{ connectorType: null, maxPowerKw: null }])).toBeNull();
    expect(evseChargingKind([])).toBeNull();
  });
});

describe('tariffAppliesTo', () => {
  it('applies Both to every kind and AC or DC only to its own known kind', () => {
    expect(tariffAppliesTo(BOTH_ALL, undefined)).toBe(true);
    expect(tariffAppliesTo(BOTH_ALL, { chargingKind: 'dc' })).toBe(true);
    expect(tariffAppliesTo(AC_ALL, { chargingKind: 'ac' })).toBe(true);
    expect(tariffAppliesTo(AC_ALL, { chargingKind: 'dc' })).toBe(false);
    expect(tariffAppliesTo(AC_ALL, { chargingKind: null })).toBe(false);
    expect(tariffAppliesTo(AC_ALL, undefined)).toBe(false);
  });

  it('applies Selected Sites only at a listed, known site', () => {
    expect(tariffAppliesTo(BOTH_A, { siteId: 'site_a' })).toBe(true);
    expect(tariffAppliesTo(BOTH_A, { siteId: 'site_b' })).toBe(false);
    expect(tariffAppliesTo(BOTH_A, { siteId: null })).toBe(false);
    expect(tariffAppliesTo(NONE, { chargingKind: 'ac', siteId: 'site_a' })).toBe(false);
    expect(tariffAppliesTo(AC_A, { chargingKind: 'ac', siteId: 'site_a' })).toBe(true);
  });
});

describe('specificity order (D-A)', () => {
  it('scores AC or DC and Selected Sites one point each', () => {
    expect(tariffSpecificity(BOTH_ALL)).toBe(0);
    expect(tariffSpecificity(AC_ALL)).toBe(1);
    expect(tariffSpecificity(BOTH_A)).toBe(1);
    expect(tariffSpecificity(AC_A)).toBe(2);
    expect(isUnscopedTariff(BOTH_ALL)).toBe(true);
    expect(isUnscopedTariff(AC_ALL)).toBe(false);
  });

  it('lets the more specific scope win and refuses only incomparable overlaps', () => {
    expect(tariffScopeDominates(AC_ALL, BOTH_ALL)).toBe(true);
    expect(tariffScopeDominates(BOTH_A, BOTH_ALL)).toBe(true);
    expect(tariffScopeDominates(AC_A, BOTH_A)).toBe(true);
    expect(tariffScopeDominates(AC_A, AC_ALL)).toBe(true);
    expect(tariffScopeDominates(AC_ALL, BOTH_A)).toBe(false);
    expect(tariffScopeDominates(BOTH_A, AC_ALL)).toBe(false);

    expect(tariffScopesConflict(AC_ALL, DC_ALL)).toBe(false);
    expect(tariffScopesConflict(AC_ALL, BOTH_ALL)).toBe(false);
    expect(tariffScopesConflict(AC_ALL, AC_ALL)).toBe(true);
    expect(tariffScopesConflict(BOTH_ALL, BOTH_ALL)).toBe(true);
    expect(tariffScopesConflict(AC_AB, AC_BC)).toBe(true);
    expect(tariffScopesConflict(AC_A, AC_C)).toBe(false);
    expect(tariffScopesConflict(AC_ALL, BOTH_A)).toBe(true);
    expect(tariffScopesOverlap(NONE, AC_A)).toBe(false);
  });

  it('lists AC and DC for a station whose EVSEs differ', () => {
    expect(chargingKindsOf(['ac', 'ac'])).toEqual(['ac']);
    expect(chargingKindsOf(['dc', 'ac', null])).toEqual(['ac', 'dc']);
    expect(chargingKindsOf(['mixed'])).toEqual(['ac', 'dc']);
    expect(chargingKindsOf([null])).toEqual([]);
  });
});

function tariff(
  id: string,
  priority: number,
  scope: TariffScope,
  restrictions: TariffWithRestrictions['restrictions'] = null,
  isDefault = false,
): TariffWithRestrictions {
  return {
    id,
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
    restrictions,
    priority,
    isDefault,
    ...scope,
  };
}

describe('resolveActiveTariff with a charging kind and a site', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0);
  const group = [
    tariff('def', 0, BOTH_ALL, null, true),
    tariff('ac', 0, AC_ALL),
    tariff('dc', 0, DC_ALL),
  ];

  it('picks the AC or DC tariff by the kind and the default for an unknown kind', () => {
    expect(resolveActiveTariff(group, now, [], 0, undefined, { chargingKind: 'ac' })?.id).toBe(
      'ac',
    );
    expect(resolveActiveTariff(group, now, [], 0, undefined, { chargingKind: 'dc' })?.id).toBe(
      'dc',
    );
    expect(resolveActiveTariff(group, now, [], 0, undefined, { chargingKind: null })?.id).toBe(
      'def',
    );
    expect(resolveActiveTariff(group, now, [], 0)?.id).toBe('def');
  });

  it('keeps priority first: a Both peak tariff beats an unrestricted AC tariff', () => {
    const tariffs = [
      ...group,
      tariff('peak', 10, BOTH_ALL, { timeRange: { startTime: '09:00', endTime: '17:00' } }),
    ];
    expect(resolveActiveTariff(tariffs, now, [], 0, undefined, { chargingKind: 'ac' })?.id).toBe(
      'peak',
    );
  });

  it('prefers the more specific tariff at one priority', () => {
    const window = { timeRange: { startTime: '09:00', endTime: '17:00' } };
    const tariffs = [
      tariff('def', 0, BOTH_ALL, null, true),
      tariff('both-peak', 10, BOTH_ALL, window),
      tariff('ac-peak', 10, AC_ALL, window),
      tariff('ac-a-peak', 10, AC_A, window),
    ];
    const ctx = (siteId: string) => ({ chargingKind: 'ac' as const, siteId });
    expect(resolveActiveTariff(tariffs, now, [], 0, undefined, ctx('site_a'))?.id).toBe(
      'ac-a-peak',
    );
    expect(resolveActiveTariff(tariffs, now, [], 0, undefined, ctx('site_b'))?.id).toBe('ac-peak');
    expect(
      resolveActiveTariff(tariffs, now, [], 0, undefined, { chargingKind: 'dc', siteId: 'site_a' })
        ?.id,
    ).toBe('both-peak');
  });

  it('skips a Selected Sites tariff elsewhere and returns to the default', () => {
    const tariffs = [tariff('def', 0, BOTH_ALL, null, true), tariff('a', 0, BOTH_A)];
    expect(resolveActiveTariff(tariffs, now, [], 0, undefined, { siteId: 'site_a' })?.id).toBe('a');
    expect(resolveActiveTariff(tariffs, now, [], 0, undefined, { siteId: 'site_b' })?.id).toBe(
      'def',
    );
  });

  it('orders the threshold before the scope within priority 50', () => {
    const a = tariff('ac50', 50, AC_ALL, { energyThresholdKwh: 50 });
    const b = tariff('both60', 50, BOTH_ALL, { energyThresholdKwh: 60 });
    expect(compareTariffs(a, b)).toBeGreaterThan(0);
  });
});

describe('validateNoOverlap with scopes (D-A)', () => {
  const row = (id: string, priority: number, scope: TariffScope, r = null) => ({
    id,
    priority,
    restrictions: r,
    ...scope,
  });

  it('accepts unrestricted AC and DC tariffs next to the default', () => {
    const existing = [row('def', 0, BOTH_ALL)];
    expect(validateNoOverlap(existing, null, 0, undefined, AC_ALL).valid).toBe(true);
    expect(
      validateNoOverlap([...existing, row('ac', 0, AC_ALL)], null, 0, undefined, DC_ALL).valid,
    ).toBe(true);
  });

  it('refuses a second AC tariff and an incomparable crossed pair', () => {
    const existing = [row('def', 0, BOTH_ALL), row('ac', 0, AC_ALL)];
    const second = validateNoOverlap(existing, null, 0, undefined, AC_ALL);
    expect(second.valid).toBe(false);
    expect(second.conflictingTariffId).toBe('ac');
    expect(validateNoOverlap(existing, null, 0, undefined, BOTH_A).valid).toBe(false);
    expect(validateNoOverlap(existing, null, 0, undefined, AC_A).valid).toBe(true);
  });

  it('compares time windows only between conflicting scopes', () => {
    const window = { timeRange: { startTime: '09:00', endTime: '17:00' } };
    const existing = [
      { id: 'ac-peak', priority: 10, restrictions: window, chargingType: 'ac' as const },
    ];
    expect(validateNoOverlap(existing, window, 10, undefined, DC_ALL).valid).toBe(true);
    expect(validateNoOverlap(existing, window, 10, undefined, BOTH_ALL).valid).toBe(true);
    expect(validateNoOverlap(existing, window, 10, undefined, AC_ALL).valid).toBe(false);
  });
});

describe('the default rule with scopes', () => {
  it('refuses an AC or Selected Sites tariff as the default', () => {
    expect(isDefaultCapableTariff({ restrictions: null })).toBe(true);
    expect(isDefaultCapableTariff({ restrictions: null, chargingType: 'ac' })).toBe(false);
    expect(isDefaultCapableTariff({ restrictions: null, siteIds: ['site_a'] })).toBe(false);
    const check = checkGroupDefault([
      { id: 'ac', restrictions: null, chargingType: 'ac', isDefault: true, isActive: true },
    ]);
    expect(check).toEqual({ valid: false, reason: 'restricted_default', tariffId: 'ac' });
  });

  it('needs a default next to unrestricted AC and DC tariffs', () => {
    expect(
      checkGroupDefault([
        { id: 'ac', restrictions: null, chargingType: 'ac', isDefault: false, isActive: true },
      ]),
    ).toEqual({ valid: false, reason: 'no_default' });
  });
});
