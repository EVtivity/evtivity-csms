// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

const { valuesFn } = vi.hoisted(() => ({ valuesFn: vi.fn() }));

vi.mock('@evtivity/database', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (rows: unknown) => {
        valuesFn(rows);
        return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
      },
    })),
  },
  driverTokens: {},
}));

vi.mock('@evtivity/database/src/lib/id.js', () => ({
  createId: vi.fn(() => 'dtk_test'),
}));

import {
  generateTestTokens,
  provisionTestTokens,
  TEST_PREPAID_BALANCE_CENTS,
} from '../test-tokens.js';

describe('test tokens', () => {
  it('generates 16-character tokens that fit the OCPP 1.6 idTag', () => {
    const tokens = generateTestTokens();
    for (const value of Object.values(tokens)) {
      expect(value).toHaveLength(16);
    }
  });

  it('provisions the prepaid token with credit and the noCredit token with a zero balance', async () => {
    const tokens = generateTestTokens();
    await provisionTestTokens('drv_1', tokens);

    const rows = valuesFn.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    const byToken = new Map(rows.map((r) => [r['idToken'], r]));
    expect(byToken.get(tokens.prepaid)?.['prepaidBalanceCents']).toBe(TEST_PREPAID_BALANCE_CENTS);
    expect(byToken.get(tokens.noCredit)?.['prepaidBalanceCents']).toBe(0);
    expect(byToken.get(tokens.valid)?.['prepaidBalanceCents']).toBeUndefined();
    expect(byToken.get(tokens.blocked)?.['isActive']).toBe(false);
  });
});
