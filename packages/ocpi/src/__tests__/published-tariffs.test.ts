// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({
  db: {},
  ocpiTariffMappings: {},
  pricingGroups: {},
  pricingHolidays: {},
  tariffs: {},
  getCompanyCurrency: vi.fn(),
}));

const { effectiveMappings, publishedToday } = await import('../services/published-tariffs.js');

const at = new Date('2026-09-01T00:00:00Z');
function mapping(id: number, partnerId: string | null, ocpiTariffId: string) {
  return { id, partnerId, ocpiTariffId, tariffId: 'trf_1', pricingGroupId: null, updatedAt: at };
}

describe('effectiveMappings', () => {
  it('keeps global mappings and the partner own ones, not other partners', () => {
    const rows = [mapping(1, null, 'A'), mapping(2, 'opr_1', 'B'), mapping(3, 'opr_2', 'C')];
    expect(effectiveMappings(rows, 'opr_1').map((m) => m.id)).toEqual([1, 2]);
  });

  it('lets a partner mapping replace the global one with the same OCPI tariff id', () => {
    for (const rows of [
      [mapping(1, null, 'A'), mapping(2, 'opr_1', 'A')],
      [mapping(2, 'opr_1', 'A'), mapping(1, null, 'A')],
    ]) {
      expect(effectiveMappings(rows, 'opr_1').map((m) => m.id)).toEqual([2]);
    }
    expect(
      effectiveMappings([mapping(1, null, 'A'), mapping(2, 'opr_1', 'A')], 'opr_2').map(
        (m) => m.id,
      ),
    ).toEqual([1]);
  });
});

describe('publishedToday', () => {
  it('keeps a holiday until it has ended in the last timezone (B19)', () => {
    // 2026-12-26 02:00 UTC is still December 25 in Los Angeles.
    expect(publishedToday(new Date('2026-12-26T02:00:00Z'))).toBe('2026-12-25');
    expect(publishedToday(new Date('2026-12-26T11:59:00Z'))).toBe('2026-12-25');
    expect(publishedToday(new Date('2026-12-26T12:00:00Z'))).toBe('2026-12-26');
  });
});
