// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Property test of tariff choice by charging kind and site (owner decisions
// 2026-11-13, D-A and D-E): random groups that pass the overlap check, random
// kinds, sites, times and energies; the resolver must pick the tariff the
// independent oracle (`testing/pricing-oracle.ts`) picks, and the oracle must
// find exactly one winner (no ambiguous level in a valid group).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveActiveTariff } from '../tariff-resolver.js';
import type { TariffWithRestrictions } from '../tariff-resolver.js';
import { validateNoOverlap } from '../tariff-overlap.js';
import { derivePriority, tariffMatchesNow } from '../tariff-restrictions.js';
import type { TariffRestrictions } from '../tariff-restrictions.js';
import type { TariffChargingType } from '../tariff-scope.js';
import { pickScopedTariffOracle } from '../testing/pricing-oracle.js';
import type { OracleScopedTariff } from '../testing/pricing-oracle.js';

const SITES = ['site_a', 'site_b', 'site_c'] as const;
const WINDOWS: TariffRestrictions[] = [
  { timeRange: { startTime: '09:00', endTime: '17:00' } },
  { timeRange: { startTime: '12:00', endTime: '14:00' } },
  { timeRange: { startTime: '18:00', endTime: '22:00' } },
  { energyThresholdKwh: 10 },
  { energyThresholdKwh: 20 },
];

const candidate = fc.record({
  restriction: fc.option(fc.constantFrom(...WINDOWS), { nil: null }),
  chargingType: fc.constantFrom<TariffChargingType>('ac', 'dc', 'both'),
  sites: fc.option(fc.subarray([...SITES], { minLength: 1 }), { nil: null }),
});

function base(id: string): Omit<TariffWithRestrictions, 'restrictions' | 'priority' | 'isDefault'> {
  return {
    id,
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
  };
}

describe('tariff choice by kind and site agrees with the oracle', () => {
  it('on 2000 random valid groups and contexts', () => {
    fc.assert(
      fc.property(
        fc.array(candidate, { maxLength: 10 }),
        fc.constantFrom<'ac' | 'dc' | null>('ac', 'dc', null),
        fc.constantFrom<string | null>(...SITES, null),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 30 }),
        (cands, chargingKind, siteId, hour, energy) => {
          const group: TariffWithRestrictions[] = [
            { ...base('t00'), restrictions: null, priority: 0, isDefault: true },
          ];
          cands.forEach((c, i) => {
            const priority = derivePriority(c.restriction);
            const scope = { chargingType: c.chargingType, siteIds: c.sites };
            if (priority === 0 && c.chargingType === 'both' && c.sites == null) return;
            const check = validateNoOverlap(group, c.restriction, priority, undefined, scope);
            if (!check.valid) return;
            group.push({
              ...base(`t${String(i + 1).padStart(2, '0')}`),
              restrictions: c.restriction,
              priority,
              isDefault: false,
              ...scope,
            });
          });
          const now = new Date(Date.UTC(2026, 2, 4, hour, 30));
          const ctx = { chargingKind, siteId };
          const got = resolveActiveTariff(group, now, [], energy, 'UTC', ctx);
          const oracle = pickScopedTariffOracle(
            group.map(
              (t): OracleScopedTariff => ({
                id: t.id,
                priority: t.priority,
                threshold: t.restrictions?.energyThresholdKwh ?? 0,
                restrictionMatches:
                  t.restrictions == null ||
                  tariffMatchesNow(t.restrictions, now, [], energy, 'UTC'),
                isDefault: t.isDefault,
                chargingType: t.chargingType ?? 'both',
                siteIds: t.siteIds == null ? null : [...t.siteIds],
              }),
            ),
            ctx,
          );
          expect(oracle).not.toBeNull();
          expect(got?.id ?? null).toBe(oracle);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
