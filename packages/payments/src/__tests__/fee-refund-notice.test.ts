// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where']) chain[method] = () => chain;
  chain['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows.shift() ?? []).then(resolve, reject);
  return { rows, select: vi.fn(() => chain), dispatchDriverNotification: vi.fn() };
});

vi.mock('@evtivity/database', () => ({
  db: { select: h.select },
  client: { __client: true },
  reservations: { id: 'r.id', reservationId: 'r.reservation_id' },
}));
vi.mock('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchDriverNotification: h.dispatchDriverNotification,
}));

import { dispatchFeeRefundNotification } from '../fee-refund-notice.js';
import type { PaymentRecord } from '../payment-records.js';

const pubsub = { publish: vi.fn(), subscribe: vi.fn(), ping: vi.fn() };
const deps = { templatesDirs: ['/t'], pubsub: pubsub as never };

function fee(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 7,
    sessionId: null,
    driverId: 'd1',
    currency: 'EUR',
    capturedAmountCents: 595,
    chargeType: 'reservation_cancellation',
    reservationId: 'rsv_1',
    ...overrides,
  } as PaymentRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0;
  h.dispatchDriverNotification.mockResolvedValue(undefined);
});

describe('dispatchFeeRefundNotification', () => {
  it('sends payment.FeeRefunded for a cancellation fee with the reservation id', async () => {
    h.rows.push([{ reservationId: 1042 }]);
    await dispatchFeeRefundNotification(fee(), 200, deps);
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'payment.FeeRefunded',
      'd1',
      {
        amountCents: 200,
        amountFormatted: expect.objectContaining({ cents: 200, currency: 'EUR' }) as unknown,
        currency: 'EUR',
        feeType: 'cancellation',
        isNoShowFee: false,
        reservationId: '1042',
        refundedAt: expect.any(String) as unknown,
      },
      ['/t'],
      pubsub,
    );
  });

  it('marks a no-show fee', async () => {
    h.rows.push([{ reservationId: 7 }]);
    await dispatchFeeRefundNotification(fee({ chargeType: 'reservation_no_show' }), 300, deps);
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'payment.FeeRefunded',
      'd1',
      expect.objectContaining({ feeType: 'no_show', isNoShowFee: true }),
      ['/t'],
      pubsub,
    );
  });

  it('sends an empty reservation id when the reservation was deleted', async () => {
    await dispatchFeeRefundNotification(fee({ reservationId: null }), 595, {
      ...deps,
      pubsub: null,
    });
    expect(h.select).not.toHaveBeenCalled();
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'payment.FeeRefunded',
      'd1',
      expect.objectContaining({ reservationId: '' }),
      ['/t'],
      undefined,
    );
  });

  it('sends nothing for a session record or a record without a driver', async () => {
    await dispatchFeeRefundNotification(fee({ chargeType: 'session' }), 100, deps);
    await dispatchFeeRefundNotification(fee({ driverId: null }), 100, deps);
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });
});
