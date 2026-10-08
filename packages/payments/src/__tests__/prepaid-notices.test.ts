// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where']) chain[method] = () => chain;
  chain['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows.shift() ?? []).then(resolve, reject);
  return {
    rows,
    select: vi.fn(() => chain),
    dispatchDriverNotification: vi.fn(),
    threshold: vi.fn(),
    currency: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: { select: h.select },
  client: { __client: true },
  driverTokens: { id: 't.id', driverId: 't.driver_id', idToken: 't.id_token' },
  getPrepaidLowCreditThresholdCents: h.threshold,
  getCompanyCurrency: h.currency,
}));
vi.mock('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchDriverNotification: h.dispatchDriverNotification,
}));

import { crossedLowCreditThreshold, dispatchPrepaidLowCreditNotice } from '../prepaid-notices.js';

const pubsub = { publish: vi.fn(), subscribe: vi.fn(), ping: vi.fn() };
const deps = { templatesDirs: ['/t'], pubsub: pubsub as never };

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0;
  h.threshold.mockResolvedValue(500);
  h.currency.mockResolvedValue('EUR');
  h.dispatchDriverNotification.mockResolvedValue(undefined);
});

describe('crossedLowCreditThreshold', () => {
  it('is true only when the debit takes the balance from at or above the threshold to below it', () => {
    expect(crossedLowCreditThreshold({ debitedCents: 200, balanceCents: 400 }, 500)).toBe(true);
    expect(crossedLowCreditThreshold({ debitedCents: 100, balanceCents: 400 }, 500)).toBe(true);
    expect(crossedLowCreditThreshold({ debitedCents: 100, balanceCents: 500 }, 500)).toBe(false);
    // Already below before the debit: notified at the earlier crossing.
    expect(crossedLowCreditThreshold({ debitedCents: 50, balanceCents: 300 }, 500)).toBe(false);
    // A debit into a negative balance from above the threshold still crosses.
    expect(crossedLowCreditThreshold({ debitedCents: 900, balanceCents: -100 }, 500)).toBe(true);
  });

  it('is false when the threshold is 0 (off)', () => {
    expect(crossedLowCreditThreshold({ debitedCents: 1000, balanceCents: -1 }, 0)).toBe(false);
  });
});

describe('dispatchPrepaidLowCreditNotice', () => {
  it('sends prepaid.LowCredit to the token driver when the debit crosses the threshold', async () => {
    h.rows.push([{ driverId: 'drv_1', idToken: 'PREPAID-1' }]);
    const sent = await dispatchPrepaidLowCreditNotice(
      { tokenId: 'tok_1', debitedCents: 700, balanceCents: 300 },
      deps,
    );
    expect(sent).toBe(true);
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'prepaid.LowCredit',
      'drv_1',
      {
        idToken: 'PREPAID-1',
        balanceCents: 300,
        balanceFormatted: { cents: 300, currency: 'EUR' },
        thresholdFormatted: { cents: 500, currency: 'EUR' },
        currency: 'EUR',
      },
      ['/t'],
      pubsub,
    );
  });

  it('sends nothing for a repeated settlement', async () => {
    const sent = await dispatchPrepaidLowCreditNotice(
      { tokenId: 'tok_1', debitedCents: 700, balanceCents: 300, repeated: true },
      deps,
    );
    expect(sent).toBe(false);
    expect(h.threshold).not.toHaveBeenCalled();
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('sends nothing when the balance stays at or above the threshold', async () => {
    const sent = await dispatchPrepaidLowCreditNotice(
      { tokenId: 'tok_1', debitedCents: 100, balanceCents: 900 },
      deps,
    );
    expect(sent).toBe(false);
    expect(h.select).not.toHaveBeenCalled();
  });

  it('sends nothing for a token without a driver', async () => {
    h.rows.push([{ driverId: null, idToken: 'PREPAID-1' }]);
    const sent = await dispatchPrepaidLowCreditNotice(
      { tokenId: 'tok_1', debitedCents: 700, balanceCents: 300 },
      deps,
    );
    expect(sent).toBe(false);
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
  });
});
