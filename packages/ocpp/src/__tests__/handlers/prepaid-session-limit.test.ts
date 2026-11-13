// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  calls: [] as { text: string; values: unknown[] }[],
  extendFleetSessionCeiling: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  client: (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push({ text: strings.join('?'), values });
    return Promise.resolve(h.rows);
  },
  extendFleetSessionCeiling: h.extendFleetSessionCeiling,
}));

const {
  prepaidSessionCeilingCents,
  accountSessionCeilingCents,
  markAccountCeilingSent,
  takeGrownAccountCeiling,
  raiseAccountCeilingAtCostLimit,
} = await import('../../handlers/prepaid-session-limit.js');

describe('prepaidSessionCeilingCents', () => {
  beforeEach(() => {
    h.rows = [];
    h.calls = [];
  });

  it('returns the ceiling of the session linked to the token', async () => {
    h.rows = [{ cost_ceiling_cents: 600 }];
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBe(600);
    expect(h.calls[0]?.values).toEqual(['CS-1', 'tx-1', 'tok-1']);
    expect(h.calls[0]?.text).toContain('cs.token_id =');
  });

  it('returns 0 for a session without credit', async () => {
    h.rows = [{ cost_ceiling_cents: '0' }];
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBe(0);
  });

  it('returns null when the session is not linked or has no ceiling', async () => {
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBeNull();
    h.rows = [{ cost_ceiling_cents: null }];
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBeNull();
  });
});

describe('accountSessionCeilingCents', () => {
  beforeEach(() => {
    h.rows = [];
    h.calls = [];
  });

  it('returns the ceiling the gate reserved for the account session', async () => {
    h.rows = [{ cost_ceiling_cents: '1200' }];
    await expect(accountSessionCeilingCents('CS-1', 'tx-1')).resolves.toBe(1200);
    expect(h.calls[0]?.values).toEqual(['CS-1', 'tx-1']);
    expect(h.calls[0]?.text).toContain("cs.billing_mode = 'account'");
  });

  it('returns null for a session not billed on account or without a ceiling', async () => {
    await expect(accountSessionCeilingCents('CS-1', 'tx-1')).resolves.toBeNull();
    h.rows = [{ cost_ceiling_cents: null }];
    await expect(accountSessionCeilingCents('CS-1', 'tx-1')).resolves.toBeNull();
  });
});

describe('account ceiling sends (E16.FR.02)', () => {
  beforeEach(() => {
    h.rows = [];
    h.calls = [];
    h.extendFleetSessionCeiling.mockReset();
  });

  it('records the sent ceiling of an account session only', async () => {
    await markAccountCeilingSent('CS-1', 'tx-1', 900);
    expect(h.calls[0]?.values).toEqual([900, 'CS-1', 'tx-1']);
    expect(h.calls[0]?.text).toContain("cs.billing_mode = 'account'");
  });

  it('claims a grown ceiling once, in the statement that reads it', async () => {
    h.rows = [{ cost_ceiling_cents: '1500' }];
    await expect(takeGrownAccountCeiling('CS-1', 'tx-1')).resolves.toBe(1500);
    expect(h.calls[0]?.text).toContain('SET cost_ceiling_sent_cents = cs.cost_ceiling_cents');
    expect(h.calls[0]?.text).toContain('cs.cost_ceiling_cents > cs.cost_ceiling_sent_cents');
    h.rows = [];
    await expect(takeGrownAccountCeiling('CS-1', 'tx-1')).resolves.toBeNull();
  });
});

describe('raiseAccountCeilingAtCostLimit (E16.FR.05)', () => {
  beforeEach(() => {
    h.rows = [];
    h.calls = [];
    h.extendFleetSessionCeiling.mockReset();
  });

  it('raises nothing for a session that is not a running account session with a sent limit', async () => {
    await expect(raiseAccountCeilingAtCostLimit('CS-1', 'tx-1')).resolves.toBe(false);
    expect(h.extendFleetSessionCeiling).not.toHaveBeenCalled();
  });

  it('extends from the larger of the sent limit and the running cost', async () => {
    h.rows = [
      {
        id: 'ses_1',
        billing_fleet_id: 'flt_1',
        cost_ceiling_sent_cents: 500,
        current_cost_cents: 650,
      },
    ];
    h.extendFleetSessionCeiling.mockResolvedValueOnce({ ceilingCents: 1150 });
    await expect(raiseAccountCeilingAtCostLimit('CS-1', 'tx-1')).resolves.toBe(true);
    expect(h.extendFleetSessionCeiling).toHaveBeenCalledWith(expect.anything(), 'flt_1', 'ses_1', {
      pricedCents: 650,
    });
  });

  it('answers false when the fleet has no credit left or the ceiling did not pass the reached cost', async () => {
    h.rows = [
      {
        id: 'ses_1',
        billing_fleet_id: 'flt_1',
        cost_ceiling_sent_cents: '500',
        current_cost_cents: null,
      },
    ];
    h.extendFleetSessionCeiling.mockResolvedValueOnce(null);
    await expect(raiseAccountCeilingAtCostLimit('CS-1', 'tx-1')).resolves.toBe(false);
    expect(h.extendFleetSessionCeiling).toHaveBeenCalledWith(expect.anything(), 'flt_1', 'ses_1', {
      pricedCents: 500,
    });
    h.extendFleetSessionCeiling.mockResolvedValueOnce({ ceilingCents: 500 });
    await expect(raiseAccountCeilingAtCostLimit('CS-1', 'tx-1')).resolves.toBe(false);
  });
});
