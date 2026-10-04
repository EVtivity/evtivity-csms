// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('@evtivity/database', async () => (await import('./helpers/session-db.js')).databaseMock);
vi.mock('../settings.js', async () => (await import('./helpers/session-db.js')).settingsMock);
vi.mock('../payment-records.js', async () => (await import('./helpers/memory-records.js')).records);

import {
  allocateRefund,
  paymentCharges,
  topUpCharges,
  unlistedTopUpCents,
  withTopUpRefunds,
} from '../top-ups.js';
import type { ChargeRecord } from '../top-ups.js';
import { SimulatedPaymentProvider } from '../providers/simulated/index.js';
import {
  authorizeSessionHold,
  retryShortfallForRecord,
  settleSessionPayment,
} from '../session-payments.js';
import { refundPaymentRecord } from '../refunds.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';
import { memoryRecords } from './helpers/memory-records.js';
import { sessionDb } from './helpers/session-db.js';

function rec(overrides: Partial<ChargeRecord> = {}): ChargeRecord {
  return {
    providerPaymentId: 'pi_hold',
    capturedAmountCents: 3000,
    refundedAmountCents: 0,
    preAuthAmountCents: 2000,
    metadata: {
      topUps: [
        { paymentId: 'pi_t1', amountCents: 600, refundedCents: 0 },
        { paymentId: 'pi_t2', amountCents: 400, refundedCents: 0 },
      ],
    },
    ...overrides,
  };
}

describe('topUpCharges', () => {
  it('reads metadata.topUps and drops malformed entries', () => {
    expect(
      topUpCharges(
        rec({
          metadata: {
            topUps: [
              { paymentId: 'pi_t1', amountCents: 600, refundedCents: 100 },
              { paymentId: 'pi_bad' },
              null,
            ],
          },
        }),
      ),
    ).toEqual([{ paymentId: 'pi_t1', amountCents: 600, refundedCents: 100 }]);
  });

  it('ignores a legacy topUpIntentId (migration 0121 rewrites it as topUps)', () => {
    expect(
      topUpCharges(rec({ capturedAmountCents: 2600, metadata: { topUpIntentId: 'pi_old' } })),
    ).toEqual([]);
  });

  it('is empty without metadata, for other metadata and a non-list', () => {
    expect(topUpCharges(rec({ metadata: null }))).toEqual([]);
    expect(topUpCharges(rec({ metadata: { tokenId: 't1' } }))).toEqual([]);
    expect(topUpCharges(rec({ metadata: { topUps: 'pi_t1' } }))).toEqual([]);
    expect(topUpCharges(rec({ metadata: 'text' }))).toEqual([]);
  });
});

describe('paymentCharges', () => {
  it('lists the hold with what the top-ups do not account for, then each top-up', () => {
    expect(
      paymentCharges(
        rec({
          refundedAmountCents: 2300,
          metadata: {
            topUps: [
              { paymentId: 'pi_t1', amountCents: 600, refundedCents: 300 },
              { paymentId: 'pi_t2', amountCents: 400, refundedCents: 0 },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: 'hold', paymentId: 'pi_hold', capturedCents: 2000, refundedCents: 2000, number: 0 },
      { kind: 'top_up', paymentId: 'pi_t1', capturedCents: 600, refundedCents: 300, number: 1 },
      { kind: 'top_up', paymentId: 'pi_t2', capturedCents: 400, refundedCents: 0, number: 2 },
    ]);
  });

  it('is the hold alone without top-ups, and has no hold without a payment id', () => {
    expect(paymentCharges(rec({ metadata: null }))).toEqual([
      { kind: 'hold', paymentId: 'pi_hold', capturedCents: 3000, refundedCents: 0, number: 0 },
    ]);
    expect(paymentCharges(rec({ providerPaymentId: null, metadata: null }))).toEqual([]);
  });
});

describe('unlistedTopUpCents', () => {
  it('is the capture above the hold that no listed top-up accounts for', () => {
    // A retry top-up recorded before v0.1.37: id only in last_action_reason.
    expect(unlistedTopUpCents(rec({ capturedAmountCents: 2500, metadata: null }))).toBe(500);
    expect(
      unlistedTopUpCents(
        rec({
          capturedAmountCents: 3300,
          metadata: { topUps: [{ paymentId: 'pi_t1', amountCents: 600, refundedCents: 0 }] },
        }),
      ),
    ).toBe(700);
  });

  it('is 0 when the hold and the listed top-ups account for the capture', () => {
    expect(unlistedTopUpCents(rec())).toBe(0);
    expect(unlistedTopUpCents(rec({ capturedAmountCents: 1500, metadata: null }))).toBe(0);
  });

  it('is 0 without a hold payment or a hold amount', () => {
    expect(unlistedTopUpCents(rec({ preAuthAmountCents: null, metadata: null }))).toBe(0);
    expect(unlistedTopUpCents(rec({ providerPaymentId: null, metadata: null }))).toBe(0);
  });
});

describe('allocateRefund', () => {
  const charges = paymentCharges(rec());
  const split = (amount: number) =>
    allocateRefund(charges, amount).map((p) => [p.charge.paymentId, p.amountCents]);

  it('fills the hold first, then each top-up in order', () => {
    expect(split(1500)).toEqual([['pi_hold', 1500]]);
    expect(split(2000)).toEqual([['pi_hold', 2000]]);
    expect(split(2700)).toEqual([
      ['pi_hold', 2000],
      ['pi_t1', 600],
      ['pi_t2', 100],
    ]);
    expect(split(3000)).toEqual([
      ['pi_hold', 2000],
      ['pi_t1', 600],
      ['pi_t2', 400],
    ]);
  });

  it('skips refunded charges and stops at what the charges hold', () => {
    const partly = paymentCharges(
      rec({
        refundedAmountCents: 2600,
        metadata: {
          topUps: [
            { paymentId: 'pi_t1', amountCents: 600, refundedCents: 600 },
            { paymentId: 'pi_t2', amountCents: 400, refundedCents: 0 },
          ],
        },
      }),
    );
    expect(allocateRefund(partly, 1000).map((p) => [p.charge.paymentId, p.amountCents])).toEqual([
      ['pi_t2', 400],
    ]);
    expect(allocateRefund(partly, 0)).toEqual([]);
  });
});

describe('withTopUpRefunds', () => {
  it('raises the refunded totals it is given and never lowers one', () => {
    const topUps = topUpCharges(rec());
    expect(
      withTopUpRefunds(
        topUps.map((t) => ({ ...t, refundedCents: 100 })),
        new Map([
          ['pi_t1', 50],
          ['pi_t2', 400],
        ]),
      ),
    ).toEqual([
      { paymentId: 'pi_t1', amountCents: 600, refundedCents: 100 },
      { paymentId: 'pi_t2', amountCents: 400, refundedCents: 400 },
    ]);
  });
});

describe('top-ups through the simulated provider', () => {
  const provider = new SimulatedPaymentProvider({
    encryptionKey: 'test-encryption-key-32chars-long!',
  });
  const refund = vi.spyOn(provider, 'refund');
  let ctx: PaymentContext;

  beforeAll(() => {
    sessionDb.method = {
      id: 1,
      provider: 'simulated',
      customerId: 'cus_sim_topups',
      methodId: 'pm_sim_approve_4242_topups',
    };
    sessionDb.sitePaymentConfig = null;
    ctx = {
      registry: {
        getPaymentProvider: () => Promise.resolve(provider),
        settings: () => Promise.resolve({ preAuthAmountCents: 2000 }),
      } as unknown as PaymentProviderRegistry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  async function held(sessionId: string, finalCostCents: number): Promise<string> {
    sessionDb.current = { sessionId, finalCostCents, siteId: 'site-1' };
    const outcome = await authorizeSessionHold(
      { sessionId, driverId: 'd1', methodRowId: null, siteId: null, trigger: 'projection_gate' },
      ctx,
    );
    if (outcome.outcome !== 'authorized') throw new Error(outcome.outcome);
    return outcome.paymentId;
  }

  it('records the settlement top-up and refunds both payments in full', async () => {
    const holdId = await held('sim-settle', 2600);
    await settleSessionPayment('sim-settle', ctx);
    const record = memoryRecords.bySession('sim-settle');
    const topUps = (record?.metadata as { topUps: Array<{ paymentId: string }> }).topUps;
    expect(topUps).toEqual([
      {
        paymentId: expect.stringMatching(/^pi_sim_approve_600_/),
        amountCents: 600,
        refundedCents: 0,
      },
    ]);
    refund.mockClear();
    const outcome = await refundPaymentRecord({ sessionId: 'sim-settle' }, ctx);
    expect(outcome).toMatchObject({ status: 'refunded', refundedNowCents: 2600, full: true });
    expect(refund.mock.calls.map((c) => [c[0].paymentId, c[0].amountCents])).toEqual([
      [holdId, 2000],
      [topUps[0]?.paymentId, 600],
    ]);
    expect(memoryRecords.bySession('sim-settle')).toMatchObject({
      status: 'refunded',
      refundedAmountCents: 2600,
      metadata: { topUps: [{ amountCents: 600, refundedCents: 600 }] },
    });
  });

  it('records a retry top-up once and refunds across it', async () => {
    // A shortfall left by a declined settlement top-up, then the operator retry.
    const holdId = await held('sim-retry', 2000);
    await settleSessionPayment('sim-retry', ctx);
    const record = memoryRecords.bySession('sim-retry');
    if (record == null || sessionDb.current == null) throw new Error('no record');
    sessionDb.current.finalCostCents = 2500;
    const retried = await retryShortfallForRecord({ recordId: record.id, actorUserId: 'u1' }, ctx);
    expect(retried).toMatchObject({ status: 'recovered', shortfallCents: 500 });
    const topUpId = (retried as { topUpId: string }).topUpId;
    expect(memoryRecords.bySession('sim-retry')?.metadata).toEqual({
      topUps: [{ paymentId: topUpId, amountCents: 500, refundedCents: 0 }],
    });

    refund.mockClear();
    await refundPaymentRecord({ sessionId: 'sim-retry', amountCents: 2200 }, ctx);
    await refundPaymentRecord({ sessionId: 'sim-retry' }, ctx);
    expect(refund.mock.calls.map((c) => [c[0].paymentId, c[0].amountCents])).toEqual([
      [holdId, 2000],
      [topUpId, 200],
      [topUpId, 300],
    ]);
    expect(memoryRecords.bySession('sim-retry')).toMatchObject({
      status: 'refunded',
      refundedAmountCents: 2500,
    });
  });
});
