// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Call {
  kind: 'insert' | 'update' | 'select';
  fields?: unknown;
  table?: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: unknown;
  conflict?: unknown;
  returning?: unknown;
  lock?: string;
  join?: unknown[];
  orderBy?: unknown;
  limit?: number;
}

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: unknown[][] = [];

  function builder(kind: Call['kind'], table?: unknown): Record<string, unknown> {
    const call: Call = { kind, table };
    calls.push(call);
    const b: Record<string, unknown> = {
      from: (t: unknown) => {
        call.table = t;
        return b;
      },
      values: (v: Record<string, unknown>) => {
        call.values = v;
        return b;
      },
      set: (v: Record<string, unknown>) => {
        call.set = v;
        return b;
      },
      where: (w: unknown) => {
        call.where = w;
        return b;
      },
      onConflictDoNothing: (o: unknown) => {
        call.conflict = o;
        return b;
      },
      returning: (r?: unknown) => {
        call.returning = r ?? 'all';
        return b;
      },
      innerJoin: (...j: unknown[]) => {
        call.join = j;
        return b;
      },
      for: (mode: string) => {
        call.lock = mode;
        return b;
      },
      orderBy: (o: unknown) => {
        call.orderBy = o;
        return b;
      },
      limit: (n: number) => {
        call.limit = n;
        return b;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(results.shift() ?? []).then(resolve, reject),
    };
    return b;
  }

  const db = {
    insert: (table: unknown) => builder('insert', table),
    update: (table: unknown) => builder('update', table),
    select: (fields?: unknown) => {
      const b = builder('select');
      const call = calls[calls.length - 1];
      if (call != null) call.fields = fields;
      return b;
    },
  };
  const transaction = vi.fn((fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return {
    calls,
    results,
    db,
    builder,
    transaction,
    writeAudit: vi.fn(),
    getCompanyCurrency: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: { ...h.db, transaction: h.transaction },
  chargingSessions: {
    id: 'cs.id',
    driverId: 'cs.driver_id',
    tokenId: 'cs.token_id',
    finalCostCents: 'cs.final_cost_cents',
    currency: 'cs.currency',
    status: 'cs.status',
    stoppedReason: 'cs.stopped_reason',
    rebillStatus: 'cs.rebill_status',
  },
  SESSION_END_FAILED_REASON: 'EndRequestFailed',
  driverTokens: {
    id: 't.id',
    driverId: 't.driver_id',
    prepaidBalanceCents: 't.prepaid_balance_cents',
  },
  tokenAuditLog: { name: 'token_audit_log' },
  writeAudit: h.writeAudit,
  getCompanyCurrency: h.getCompanyCurrency,
  paymentRecords: {
    id: 'pr.id',
    sessionId: 'pr.session_id',
    status: 'pr.status',
    refundedAmountCents: 'pr.refunded_amount_cents',
    metadata: 'pr.metadata',
    reservationId: 'pr.reservation_id',
    chargeType: 'pr.charge_type',
    provider: 'pr.provider',
    providerPaymentId: 'pr.provider_payment_id',
    createdAt: 'pr.created_at',
    pendingOperation: 'pr.pending_operation',
    pendingOperationRef: 'pr.pending_operation_ref',
    pendingOperationAt: 'pr.pending_operation_at',
    providerRefunds: 'pr.provider_refunds',
    invoiceId: 'pr.invoice_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
  inArray: (col: unknown, values: unknown) => ({ op: 'inArray', col, values }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  lte: (col: unknown, value: unknown) => ({ op: 'lte', col, value }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

import {
  addPendingRefunds,
  claimFeeRecordsForInvoice,
  releaseInvoiceFeeRecords,
  claimRebillRecord,
  isStaleRebillCharge,
  REBILL_RESUME_MAX_HOURS,
  rebillChargeRequest,
  clearPendingAdjustment,
  isRebillRecord,
  confirmOperation,
  markAdjustmentPending,
  reclaimStaleAdjustment,
  matchPendingAdjustment,
  setAdjustmentRef,
  failPendingCapture,
  markAuthorisationEnded,
  recordsAwaitingConfirmation,
  settleRefund,
  findByChargePaymentId,
  findByPaymentId,
  findRecord,
  findReservationCharge,
  findSessionHold,
  findSessionRecord,
  lockRecord,
  lockSessionRecord,
  markCancelled,
  markCaptured,
  markChargeCaptured,
  markChargeFailed,
  markHoldFailed,
  markOpenPaymentFailed,
  markRefunded,
  markShortfallRecovered,
  markShortfallRetryFailed,
  recordFailedHold,
  recordGuestHold,
  recordHold,
  recordPendingCharge,
  recordsWithPayments,
  recordTerminalSettlement,
  settlePrepaidSession,
} from '../payment-records.js';

function last(): Call {
  const call = h.calls[h.calls.length - 1];
  if (call == null) throw new Error('no db call recorded');
  return call;
}

function guard(id: number, statuses: string[]): unknown {
  return {
    op: 'and',
    args: [
      { op: 'eq', col: 'pr.id', value: id },
      { op: 'inArray', col: 'pr.status', values: statuses },
    ],
  };
}

const LONG = 'x'.repeat(600);

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
});

describe('inserts', () => {
  const hold = {
    sessionId: 's1',
    driverId: 'd1',
    sitePaymentConfigId: 3,
    provider: 'stripe',
    paymentId: 'pi_1',
    customerId: 'cus_1',
    methodId: 'pm_1',
    source: 'web_portal' as const,
    currency: 'EUR',
    preAuthAmountCents: 5000,
  };

  it('recordHold inserts a pre_authorized record unique per session', async () => {
    h.results.push([{ id: 7 }]);
    expect(await recordHold(hold)).toBe(7);
    const call = last();
    expect(call.kind).toBe('insert');
    expect(call.values).toEqual({
      sessionId: 's1',
      driverId: 'd1',
      sitePaymentConfigId: 3,
      provider: 'stripe',
      providerPaymentId: 'pi_1',
      providerCustomerId: 'cus_1',
      providerPaymentMethodId: 'pm_1',
      paymentSource: 'web_portal',
      currency: 'EUR',
      preAuthAmountCents: 5000,
      status: 'pre_authorized',
    });
    expect(call.conflict).toEqual({ target: 'pr.session_id' });
    expect(call.returning).toEqual({ id: 'pr.id' });
  });

  it('recordHold returns null on conflict', async () => {
    h.results.push([]);
    expect(await recordHold(hold)).toBeNull();
  });

  it('recordFailedHold stores a failed record with the reason cut to 500 characters', async () => {
    h.results.push([{ id: 8 }]);
    const id = await recordFailedHold({
      sessionId: 's1',
      driverId: null,
      sitePaymentConfigId: null,
      provider: 'stripe',
      customerId: null,
      methodId: null,
      source: 'guest',
      currency: 'USD',
      preAuthAmountCents: null,
      reason: LONG,
    });
    expect(id).toBe(8);
    const call = last();
    expect(call.values?.['status']).toBe('failed');
    expect(call.values?.['failureReason']).toBe('x'.repeat(500));
    expect(call.values).not.toHaveProperty('providerPaymentId');
    expect(call.values).toMatchObject({
      provider: 'stripe',
      providerCustomerId: null,
    });
    expect(call.conflict).toEqual({ target: 'pr.session_id' });
  });

  it('recordFailedHold returns null on conflict', async () => {
    h.results.push([]);
    expect(
      await recordFailedHold({
        sessionId: 's1',
        driverId: null,
        sitePaymentConfigId: null,
        provider: 'stripe',
        customerId: null,
        methodId: null,
        source: 'guest',
        currency: 'USD',
        preAuthAmountCents: null,
        reason: 'declined',
      }),
    ).toBeNull();
  });

  it('recordGuestHold inserts a guest hold without a driver', async () => {
    h.results.push([{ id: 9 }]);
    expect(
      await recordGuestHold({
        sessionId: 's2',
        sitePaymentConfigId: 1,
        provider: 'stripe',
        paymentId: 'pi_g',
        currency: 'USD',
        preAuthAmountCents: 2000,
      }),
    ).toBe(9);
    const call = last();
    expect(call.values).toEqual({
      sessionId: 's2',
      driverId: null,
      sitePaymentConfigId: 1,
      provider: 'stripe',
      providerPaymentId: 'pi_g',
      paymentSource: 'guest',
      currency: 'USD',
      preAuthAmountCents: 2000,
      status: 'pre_authorized',
    });
    expect(call.conflict).toEqual({ target: 'pr.session_id' });

    h.results.push([]);
    expect(
      await recordGuestHold({
        sessionId: 's2',
        sitePaymentConfigId: null,
        provider: 'stripe',
        paymentId: 'pi_g',
        currency: 'USD',
        preAuthAmountCents: null,
      }),
    ).toBeNull();
  });

  it('recordPendingCharge is unique per reservation and fee type', async () => {
    const input = {
      chargeType: 'reservation_no_show' as const,
      reservationId: 'r1',
      driverId: 'd1',
      sitePaymentConfigId: null,
      provider: 'simulated',
      customerId: 'cus_sim_1',
      methodId: 'pm_sim_1',
      currency: 'USD',
      taxRate: 0.19,
    };
    h.results.push([{ id: 11 }]);
    expect(await recordPendingCharge(input)).toBe(11);
    const call = last();
    expect(call.values).toEqual({
      chargeType: 'reservation_no_show',
      reservationId: 'r1',
      driverId: 'd1',
      sitePaymentConfigId: null,
      provider: 'simulated',
      providerCustomerId: 'cus_sim_1',
      providerPaymentMethodId: 'pm_sim_1',
      paymentSource: 'operator',
      currency: 'USD',
      taxRate: '0.19',
      status: 'pending',
    });
    expect(call.conflict).toEqual({
      target: ['pr.reservation_id', 'pr.charge_type'],
      where: { op: 'sql', text: '? IS NOT NULL', values: ['pr.reservation_id'] },
    });

    h.results.push([]);
    expect(await recordPendingCharge(input)).toBeNull();
  });
});

describe('reads', () => {
  it('findSessionRecord, findRecord, findByPaymentId return the row or null', async () => {
    h.results.push([{ id: 1 }]);
    expect(await findSessionRecord('s1')).toEqual({ id: 1 });
    expect(last().where).toEqual({ op: 'eq', col: 'pr.session_id', value: 's1' });
    expect(last().limit).toBe(1);
    expect(await findSessionRecord('s1')).toBeNull();

    h.results.push([{ id: 2 }]);
    expect(await findRecord(2)).toEqual({ id: 2 });
    expect(last().where).toEqual({ op: 'eq', col: 'pr.id', value: 2 });
    expect(await findRecord(2)).toBeNull();

    h.results.push([{ id: 3 }]);
    expect(await findByPaymentId('stripe', 'pi_3')).toEqual({ id: 3 });
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.provider', value: 'stripe' },
        { op: 'eq', col: 'pr.provider_payment_id', value: 'pi_3' },
      ],
    });
    expect(await findByPaymentId('stripe', 'pi_3')).toBeNull();
  });

  it('findSessionHold reads only a pre_authorized record', async () => {
    h.results.push([{ id: 4 }]);
    expect(await findSessionHold('s1')).toEqual({ id: 4 });
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.session_id', value: 's1' },
        { op: 'eq', col: 'pr.status', value: 'pre_authorized' },
      ],
    });
    expect(await findSessionHold('s1')).toBeNull();
  });

  it('findReservationCharge reads by reservation and charge type', async () => {
    h.results.push([{ id: 5 }]);
    expect(await findReservationCharge('r1', 'reservation_cancellation')).toBe(5);
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.reservation_id', value: 'r1' },
        { op: 'eq', col: 'pr.charge_type', value: 'reservation_cancellation' },
      ],
    });
    expect(await findReservationCharge('r1', 'reservation_cancellation')).toBeNull();
  });

  it('lockRecord selects a record by id for update on the given transaction', async () => {
    const tx = { select: () => h.builder('select') };
    h.results.push([{ id: 7 }]);
    expect(await lockRecord(tx as never, 7)).toEqual({ id: 7 });
    expect(last()).toMatchObject({ lock: 'update', where: { op: 'eq', col: 'pr.id', value: 7 } });
    expect(await lockRecord(tx as never, 7)).toBeNull();
  });

  it('findByChargePaymentId finds the own payment first, else a listed top-up', async () => {
    h.results.push([{ id: 3 }]);
    expect(await findByChargePaymentId('stripe', 'pi_3')).toEqual({ id: 3 });
    expect(h.calls.filter((c) => c.kind === 'select')).toHaveLength(1);

    h.calls.length = 0;
    h.results.push([], [{ id: 4 }]);
    expect(await findByChargePaymentId('stripe', 'pi_top')).toEqual({ id: 4 });
    const where = last().where as {
      op: string;
      args: Array<{
        op: string;
        col?: unknown;
        value?: unknown;
        text?: string;
        values?: unknown[];
      }>;
    };
    expect(where.op).toBe('and');
    expect(where.args[0]).toEqual({ op: 'eq', col: 'pr.provider', value: 'stripe' });
    expect(where.args[1]?.text).toContain("-> 'topUps' @>");
    expect(where.args[1]?.values).toContain(JSON.stringify([{ paymentId: 'pi_top' }]));
    expect(where.args).toHaveLength(2);
    expect(last().limit).toBe(1);

    h.results.push([], []);
    expect(await findByChargePaymentId('stripe', 'pi_none')).toBeNull();
  });

  it('findByChargePaymentId never matches a payment of another provider', async () => {
    await findByChargePaymentId('adyen', 'pi_1');
    const [own, topUp] = h.calls.filter((c) => c.kind === 'select');
    expect(own?.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.provider', value: 'adyen' },
        { op: 'eq', col: 'pr.provider_payment_id', value: 'pi_1' },
      ],
    });
    expect((topUp?.where as { args: unknown[] }).args[0]).toEqual({
      op: 'eq',
      col: 'pr.provider',
      value: 'adyen',
    });
  });

  it('lockSessionRecord selects for update on the given transaction', async () => {
    const tx = { select: () => h.builder('select') };
    h.results.push([{ id: 6 }]);
    expect(await lockSessionRecord(tx as never, 's1')).toEqual({ id: 6 });
    expect(last().lock).toBe('update');
    expect(last().where).toEqual({ op: 'eq', col: 'pr.session_id', value: 's1' });
    expect(await lockSessionRecord(tx as never, 's1')).toBeNull();
  });

  it('recordsWithPayments pages records with a payment id after an id', async () => {
    const since = new Date('2026-01-01T00:00:00Z');
    h.results.push([{ id: 10 }, { id: 11 }]);
    expect(await recordsWithPayments(since, 9, 50)).toEqual([{ id: 10 }, { id: 11 }]);
    const call = last();
    expect(call.limit).toBe(50);
    expect(call.orderBy).toBe('pr.id');
    expect(call.where).toEqual({
      op: 'and',
      args: [
        { op: 'sql', text: '? >= ?', values: ['pr.created_at', since] },
        { op: 'sql', text: '? IS NOT NULL', values: ['pr.provider_payment_id'] },
        { op: 'sql', text: '? > ?', values: ['pr.id', 9] },
      ],
    });
  });
});

describe('status updates are guarded by their from-states', () => {
  it('markCaptured moves only pre_authorized and writes no metadata without a top-up', async () => {
    h.results.push([{ id: 1 }]);
    expect(await markCaptured(1, { capturedCents: 1200, failureReason: null })).toBe(true);
    const call = last();
    expect(call.set).toMatchObject({
      status: 'captured',
      capturedAmountCents: 1200,
      failureReason: null,
    });
    expect(call.set).not.toHaveProperty('metadata');
    expect(call.set?.['updatedAt']).toBeInstanceOf(Date);
    expect(call.where).toEqual(guard(1, ['pre_authorized']));

    h.results.push([]);
    expect(await markCaptured(1, { capturedCents: 1200, failureReason: null, topUp: null })).toBe(
      false,
    );
    expect(last().set).not.toHaveProperty('metadata');
  });

  it('markCaptured appends the top-up to metadata.topUps unless it is listed', async () => {
    h.results.push([{ id: 1 }]);
    expect(
      await markCaptured(1, {
        capturedCents: 5000,
        failureReason: null,
        topUp: { paymentId: 'pi_top', amountCents: 3000 },
      }),
    ).toBe(true);
    const metadata = last().set?.['metadata'] as { text: string; values: unknown[] };
    expect(metadata.text).toContain("'{topUps}'");
    expect(metadata.text).toContain('@> jsonb_build_array');
    expect(metadata.values).toContain('pi_top');
    expect(metadata.values).toContain(
      JSON.stringify({ paymentId: 'pi_top', amountCents: 3000, refundedCents: 0 }),
    );
  });

  it('markCancelled moves only pre_authorized', async () => {
    h.results.push([{ id: 2 }]);
    expect(await markCancelled(2)).toBe(true);
    expect(last().set).toMatchObject({ status: 'cancelled', capturedAmountCents: 0 });
    expect(last().where).toEqual(guard(2, ['pre_authorized']));
    expect(await markCancelled(2)).toBe(false);
  });

  it('markHoldFailed moves only pre_authorized and cuts the reason', async () => {
    h.results.push([{ id: 3 }]);
    expect(await markHoldFailed(3, LONG)).toBe(true);
    expect(last().set).toMatchObject({ status: 'failed', failureReason: 'x'.repeat(500) });
    expect(last().where).toEqual(guard(3, ['pre_authorized']));
    expect(await markHoldFailed(3, 'r')).toBe(false);
  });

  it('markChargeCaptured moves only pending', async () => {
    h.results.push([{ id: 4 }]);
    const charge = { provider: 'stripe', paymentId: 'pi_4', amountCents: 900 };
    expect(await markChargeCaptured(4, charge)).toBe(true);
    expect(last().set).toMatchObject({
      status: 'captured',
      provider: 'stripe',
      providerPaymentId: 'pi_4',
      capturedAmountCents: 900,
    });
    expect(last().where).toEqual(guard(4, ['pending']));
    expect(await markChargeCaptured(4, charge)).toBe(false);
  });

  it('markChargeFailed moves only pending and cuts the reason', async () => {
    h.results.push([{ id: 5 }]);
    expect(await markChargeFailed(5, LONG)).toBe(true);
    expect(last().set).toMatchObject({ status: 'failed', failureReason: 'x'.repeat(500) });
    expect(last().where).toEqual(guard(5, ['pending']));
    expect(await markChargeFailed(5, 'r')).toBe(false);
  });

  it('markOpenPaymentFailed moves only pending or pre_authorized', async () => {
    h.results.push([{ id: 6 }]);
    expect(await markOpenPaymentFailed(6, LONG)).toBe(true);
    expect(last().set).toMatchObject({ status: 'failed', failureReason: 'x'.repeat(500) });
    expect(last().where).toEqual(guard(6, ['pending', 'pre_authorized']));
    expect(await markOpenPaymentFailed(6, 'r')).toBe(false);
  });

  it('markRefunded moves only refundable records and never lowers the refunded total', async () => {
    h.results.push([{ id: 7, status: 'refunded' }]);
    expect(await markRefunded(7, { refundedTotalCents: 1000, full: true })).toEqual({
      id: 7,
      status: 'refunded',
    });
    const call = last();
    expect(call.set).toMatchObject({ status: 'refunded', refundedAmountCents: 1000 });
    expect(call.set).not.toHaveProperty('lastActorUserId');
    expect(call.set).not.toHaveProperty('lastActionReason');
    expect(call.returning).toBe('all');
    expect(call.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.id', value: 7 },
        { op: 'inArray', col: 'pr.status', values: ['captured', 'partially_refunded'] },
        { op: 'lte', col: 'pr.refunded_amount_cents', value: 1000 },
      ],
    });
    expect(await markRefunded(7, { refundedTotalCents: 500, full: false })).toBeNull();
    expect(last().set?.['status']).toBe('partially_refunded');
  });

  it('markRefunded records the actor and reason and uses the given executor', async () => {
    const tx = { update: (table: unknown) => h.builder('update', table) };
    h.results.push([{ id: 8 }]);
    await markRefunded(
      8,
      { refundedTotalCents: 300, full: false, actorUserId: 'u1', actionReason: 'Goodwill' },
      tx as never,
    );
    expect(last().set).toMatchObject({ lastActorUserId: 'u1', lastActionReason: 'Goodwill' });
  });

  it('markRefunded replaces metadata.topUps', async () => {
    h.results.push([{ id: 8 }]);
    const topUps = [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 600 }];
    await markRefunded(8, { refundedTotalCents: 2600, full: true, topUps });
    const metadata = last().set?.['metadata'] as { text: string; values: unknown[] };
    expect(metadata.text).toContain("'{topUps}'");
    expect(metadata.text).not.toContain('topUpIntentId');
    expect(metadata.values).toEqual(['pr.metadata', JSON.stringify(topUps)]);

    h.results.push([{ id: 8 }]);
    await markRefunded(8, { refundedTotalCents: 2600, full: true });
    expect(last().set).not.toHaveProperty('metadata');
  });

  it('markShortfallRecovered updates only a captured record and clears the reason', async () => {
    h.results.push([{ id: 9 }]);
    expect(
      await markShortfallRecovered(9, {
        capturedCents: 6000,
        actorUserId: 'u1',
        actionReason: 'Shortfall retried',
        topUp: { paymentId: 'pi_retry', amountCents: 1000 },
      }),
    ).toEqual({ id: 9 });
    const metadata = last().set?.['metadata'] as { text: string; values: unknown[] };
    expect(metadata.text).toContain("'{topUps}'");
    expect(metadata.values).toContain(
      JSON.stringify({ paymentId: 'pi_retry', amountCents: 1000, refundedCents: 0 }),
    );
    expect(last().set).toMatchObject({
      capturedAmountCents: 6000,
      failureReason: null,
      lastActorUserId: 'u1',
      lastActionReason: 'Shortfall retried',
    });
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.id', value: 9 },
        { op: 'eq', col: 'pr.status', value: 'captured' },
      ],
    });
    expect(
      await markShortfallRecovered(9, {
        capturedCents: 6000,
        actorUserId: null,
        actionReason: 'r',
        topUp: { paymentId: 'pi_retry', amountCents: 1000 },
      }),
    ).toBeNull();
    expect(last().set).not.toHaveProperty('lastActorUserId');
  });

  it('markShortfallRetryFailed updates only a captured record and cuts the reason', async () => {
    h.results.push([{ id: 10 }]);
    expect(await markShortfallRetryFailed(10, LONG)).toBe(true);
    expect(last().set).toMatchObject({ failureReason: 'x'.repeat(500) });
    expect(last().set).not.toHaveProperty('status');
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.id', value: 10 },
        { op: 'eq', col: 'pr.status', value: 'captured' },
      ],
    });
    expect(await markShortfallRetryFailed(10, 'r')).toBe(false);
  });
});

describe('recordTerminalSettlement', () => {
  const input = { sessionId: 's1', driverId: 'd1', currency: 'EUR', capturedCents: 1500 };

  it('inserts a captured terminal record unique per session', async () => {
    h.results.push([{ id: 1 }]);
    expect(await recordTerminalSettlement(input)).toBe(true);
    const call = last();
    expect(call.values).toEqual({
      sessionId: 's1',
      driverId: 'd1',
      paymentSource: 'ocpp_terminal',
      currency: 'EUR',
      capturedAmountCents: 1500,
      status: 'captured',
    });
    expect(call.conflict).toEqual({ target: 'pr.session_id' });
  });

  it('returns false on a replay', async () => {
    h.results.push([]);
    expect(await recordTerminalSettlement({ ...input, driverId: null })).toBe(false);
  });
});

describe('settlePrepaidSession', () => {
  const ROW = {
    tokenId: 't1',
    tokenDriverId: 'd_token',
    balanceCents: 5000,
    driverId: 'd1',
    finalCostCents: 1200,
    currency: 'EUR',
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    h.getCompanyCurrency.mockResolvedValue('EUR');
    h.writeAudit.mockResolvedValue(undefined);
  });

  it.each([[[]], [[{ ...ROW, balanceCents: null }]]])(
    'returns null without a prepaid token balance (%j)',
    async (rows) => {
      h.results.push(rows);
      expect(await settlePrepaidSession('s1', logger)).toBeNull();
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([[null], [0], [-5]])('returns null for a cost of %s', async (finalCostCents) => {
    h.results.push([{ ...ROW, finalCostCents }]);
    expect(await settlePrepaidSession('s1')).toBeNull();
    expect(h.getCompanyCurrency).not.toHaveBeenCalled();
  });

  it('returns null with a warn for a currency other than the company currency', async () => {
    h.results.push([{ ...ROW, currency: 'USD' }]);
    expect(await settlePrepaidSession('s1', logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: 's1', sessionCurrency: 'USD', companyCurrency: 'EUR' },
      'Prepaid session billed in another currency than the company currency; balance not debited',
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('returns null for another currency without a logger', async () => {
    h.results.push([{ ...ROW, currency: 'USD' }]);
    expect(await settlePrepaidSession('s1')).toBeNull();
  });

  it('records the prepaid payment, debits the balance and audits it', async () => {
    h.results.push([ROW], [{ id: 9 }], [{ balanceCents: 3800 }]);
    expect(await settlePrepaidSession('s1', logger)).toEqual({
      tokenId: 't1',
      debitedCents: 1200,
      balanceCents: 3800,
    });
    const [select, insert, update] = h.calls;
    expect(select?.join).toEqual([
      { id: 't.id', driverId: 't.driver_id', prepaidBalanceCents: 't.prepaid_balance_cents' },
      { op: 'eq', col: 't.id', value: 'cs.token_id' },
    ]);
    expect(select?.where).toEqual({ op: 'eq', col: 'cs.id', value: 's1' });
    expect(insert?.values).toEqual({
      sessionId: 's1',
      driverId: 'd1',
      paymentSource: 'prepaid',
      currency: 'EUR',
      capturedAmountCents: 1200,
      status: 'captured',
      metadata: { tokenId: 't1' },
    });
    expect(insert?.conflict).toEqual({ target: 'pr.session_id' });
    expect(update?.set?.['prepaidBalanceCents']).toEqual({
      op: 'sql',
      text: '? - ?',
      values: ['t.prepaid_balance_cents', 1200],
    });
    expect(update?.where).toEqual({ op: 'eq', col: 't.id', value: 't1' });
    expect(h.transaction).toHaveBeenCalledOnce();

    expect(h.writeAudit).toHaveBeenCalledOnce();
    const [target, entry, executor, adapter] = h.writeAudit.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { warn: (obj: unknown, msg?: string) => void },
    ];
    expect(target).toEqual({ table: { name: 'token_audit_log' }, idColumn: 'token_id' });
    expect(entry).toEqual({
      entityId: 't1',
      entityIdSnapshot: 't1',
      action: 'updated',
      actor: 'system',
      actorLabel: 'prepaid_debit',
      before: { prepaidBalanceCents: 5000 },
      after: { prepaidBalanceCents: 3800 },
      notes: 'Prepaid debit of 1200 for session s1',
    });
    expect(executor).toMatchObject({ insert: h.db.insert });

    adapter.warn({ err: 'x' }, 'audit failed');
    expect(logger.warn).toHaveBeenLastCalledWith({ err: 'x' }, 'audit failed');
    adapter.warn('plain');
    expect(logger.warn).toHaveBeenLastCalledWith({ detail: 'plain' }, undefined);
    adapter.warn(null, 'null obj');
    expect(logger.warn).toHaveBeenLastCalledWith({ detail: null }, 'null obj');
  });

  it('uses the token driver and passes no audit logger without one', async () => {
    h.results.push([{ ...ROW, driverId: null }], [{ id: 9 }], [{ balanceCents: -200 }]);
    expect(await settlePrepaidSession('s1')).toEqual({
      tokenId: 't1',
      debitedCents: 1200,
      balanceCents: -200,
    });
    expect(h.calls[1]?.values?.['driverId']).toBe('d_token');
    expect(h.writeAudit.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('returns null without a debit when the conflicting record cannot be read', async () => {
    h.results.push([ROW], []);
    expect(await settlePrepaidSession('s1', logger)).toBeNull();
    expect(h.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('reports the debit already recorded without debiting again', async () => {
    // A rerun after a lost connection: the first run committed the debit.
    h.results.push(
      [ROW],
      [],
      [{ capturedCents: 1200, source: 'prepaid', status: 'captured' }],
      [{ balanceCents: 3800 }],
    );
    expect(await settlePrepaidSession('s1', logger)).toEqual({
      tokenId: 't1',
      debitedCents: 1200,
      balanceCents: 3800,
      repeated: true,
    });
    expect(h.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('returns null when the session was settled another way', async () => {
    h.results.push([ROW], [], [{ capturedCents: 1200, source: 'card', status: 'captured' }]);
    expect(await settlePrepaidSession('s1', logger)).toBeNull();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it.each([['refunded'], ['partially_refunded']])(
    'returns null for a recorded debit that was %s',
    async (status) => {
      h.results.push([ROW], [], [{ capturedCents: 1200, source: 'prepaid', status }]);
      expect(await settlePrepaidSession('s1', logger)).toBeNull();
    },
  );

  it.each([[[]], [[{ balanceCents: null }]]])(
    'returns null when the balance update returns nothing (%j)',
    async (updated) => {
      h.results.push([ROW], [{ id: 9 }], updated);
      expect(await settlePrepaidSession('s1', logger)).toBeNull();
      expect(h.writeAudit).not.toHaveBeenCalled();
    },
  );
});

describe('authorisation adjustment (P10 Part D)', () => {
  const hold = {
    sessionId: 's1',
    driverId: 'd1',
    sitePaymentConfigId: null,
    provider: 'adyen',
    paymentId: 'PSP1',
    customerId: 'shopper_1',
    methodId: 'TOKEN1',
    source: 'web_portal' as const,
    currency: 'EUR',
    preAuthAmountCents: 5000,
  };

  it('recordHold stores the provider state of the hold', async () => {
    h.results.push([{ id: 7 }]);
    await recordHold({ ...hold, providerState: { adjustAuthorisationData: 'BLOB' } });
    expect(last().values).toMatchObject({ providerState: { adjustAuthorisationData: 'BLOB' } });
    h.results.push([{ id: 8 }]);
    await recordHold({ ...hold, providerState: null });
    expect(last().values).not.toHaveProperty('providerState');
  });

  it('markAdjustmentPending claims only an open hold without a pending operation', async () => {
    h.results.push([{ id: 1 }]);
    expect(await markAdjustmentPending(1)).toBe(true);
    const call = last();
    expect(call.set).toMatchObject({ pendingOperation: 'adjust', pendingOperationRef: null });
    expect(call.set?.['pendingOperationAt']).toBeInstanceOf(Date);
    const where = call.where as { args: unknown[] };
    expect(where.args.slice(0, 2)).toEqual([
      { op: 'eq', col: 'pr.id', value: 1 },
      { op: 'inArray', col: 'pr.status', values: ['pre_authorized'] },
    ]);
    expect((where.args[2] as { text: string }).text).toBe('? IS NULL');
    expect(await markAdjustmentPending(1)).toBe(false);
  });

  it('reclaimStaleAdjustment takes over only an old unreferenced claim on an open hold', async () => {
    const olderThan = new Date('2026-10-07T11:00:00Z');
    h.results.push([{ id: 1, pendingOperation: 'adjust' }]);
    expect(await reclaimStaleAdjustment(1, olderThan)).toEqual({
      id: 1,
      pendingOperation: 'adjust',
    });
    const call = last();
    expect(call.set?.['pendingOperationAt']).toBeInstanceOf(Date);
    const where = call.where as { args: unknown[] };
    expect(where.args.slice(0, 3)).toEqual([
      { op: 'eq', col: 'pr.id', value: 1 },
      { op: 'inArray', col: 'pr.status', values: ['pre_authorized'] },
      { op: 'eq', col: 'pr.pending_operation', value: 'adjust' },
    ]);
    expect((where.args[3] as { text: string }).text).toBe('? IS NULL');
    expect(where.args[4]).toMatchObject({ text: '? < ?' });
    expect((where.args[4] as { values: unknown[] }).values[1]).toBe(olderThan);
    // Nothing to take (a concurrent re-drive took it, or a webhook stored the reference).
    h.results.push([]);
    expect(await reclaimStaleAdjustment(1, olderThan)).toBeNull();
  });

  it('setAdjustmentRef stores the reference of an unreferenced pending adjustment', async () => {
    h.results.push([{ id: 2 }]);
    expect(await setAdjustmentRef(2, 'ADJ1')).toBe(true);
    const call = last();
    expect(call.set).toMatchObject({ pendingOperationRef: 'ADJ1' });
    const where = call.where as { args: unknown[] };
    expect(where.args.slice(0, 3)).toEqual([
      { op: 'eq', col: 'pr.id', value: 2 },
      { op: 'inArray', col: 'pr.status', values: ['pre_authorized'] },
      { op: 'eq', col: 'pr.pending_operation', value: 'adjust' },
    ]);
    expect((where.args[3] as { text: string }).text).toBe('? IS NULL');
    expect(await setAdjustmentRef(2, 'ADJ1')).toBe(false);
  });

  it('matchPendingAdjustment returns the open hold whose adjustment has this reference or none yet', async () => {
    h.results.push([{ id: 3, pendingOperationRef: 'ADJ1' }]);
    expect(await matchPendingAdjustment(3, 'ADJ1')).toEqual({ id: 3, pendingOperationRef: 'ADJ1' });
    const call = last();
    expect(call.set).toMatchObject({ pendingOperationRef: 'ADJ1' });
    expect(call.returning).toBe('all');
    const where = call.where as { args: unknown[] };
    expect(where.args.slice(0, 3)).toEqual([
      { op: 'eq', col: 'pr.id', value: 3 },
      { op: 'inArray', col: 'pr.status', values: ['pre_authorized'] },
      { op: 'eq', col: 'pr.pending_operation', value: 'adjust' },
    ]);
    const ref = where.args[3] as { text: string; values: unknown[] };
    expect(ref.text).toBe('(? IS NULL OR ? = ?)');
    expect(ref.values).toContain('ADJ1');
    expect(await matchPendingAdjustment(3, 'OTHER')).toBeNull();
  });

  it('clearPendingAdjustment ends only the pending adjustment of an open hold', async () => {
    h.results.push([{ id: 4 }]);
    expect(await clearPendingAdjustment(4)).toBe(true);
    expect(last().set).toMatchObject({
      pendingOperation: null,
      pendingOperationRef: null,
      pendingOperationAt: null,
    });
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.id', value: 4 },
        { op: 'inArray', col: 'pr.status', values: ['pre_authorized'] },
        { op: 'eq', col: 'pr.pending_operation', value: 'adjust' },
      ],
    });
    expect(await clearPendingAdjustment(4)).toBe(false);
  });

  it('markCaptured stores the adjusted hold as the authorized amount', async () => {
    h.results.push([{ id: 6 }], [{ id: 6 }]);
    await markCaptured(6, { capturedCents: 7000, failureReason: null, authorizedCents: 7000 });
    expect(last().set).toMatchObject({ preAuthAmountCents: 7000 });
    await markCaptured(6, { capturedCents: 7000, failureReason: null });
    expect(last().set).not.toHaveProperty('preAuthAmountCents');
  });

  it('every move out of the hold ends a pending adjustment', async () => {
    const cleared = { pendingOperation: null, pendingOperationRef: null, pendingOperationAt: null };
    h.results.push([{ id: 5 }], [{ id: 5 }], [{ id: 5 }], [{ id: 5 }], [{ id: 5 }]);
    await markCaptured(5, { capturedCents: 7000, failureReason: null });
    expect(last().set).toMatchObject(cleared);
    await markCancelled(5);
    expect(last().set).toMatchObject(cleared);
    await markHoldFailed(5, 'capture refused');
    expect(last().set).toMatchObject(cleared);
    await markOpenPaymentFailed(5, 'refused');
    expect(last().set).toMatchObject(cleared);
    await markAuthorisationEnded(5, 'expired');
    expect(last().set).toMatchObject(cleared);
  });
});

describe('async operations (P10a)', () => {
  const entry = (
    refundId: string,
    state: 'pending' | 'succeeded' | 'failed',
    paymentId = 'PSP1',
    amountCents = 500,
  ): Record<string, unknown> => ({
    refundId,
    paymentId,
    amountCents,
    state,
    requestedAt: '2026-10-03T10:00:00.000Z',
  });

  function locked(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 9,
      status: 'captured',
      providerPaymentId: 'PSP1',
      capturedAmountCents: 2000,
      refundedAmountCents: 0,
      metadata: null,
      providerRefunds: [entry('RF1', 'pending')],
      ...overrides,
    };
  }

  it('markCaptured with a pending reference records the pending capture', async () => {
    h.results.push([{ id: 1 }]);
    await markCaptured(1, { capturedCents: 1200, failureReason: null, pendingRef: 'CAP1' });
    expect(last().set).toMatchObject({
      status: 'captured',
      pendingOperation: 'capture',
      pendingOperationRef: 'CAP1',
    });
    expect(last().set?.['pendingOperationAt']).toBeInstanceOf(Date);
    expect(last().where).toEqual(guard(1, ['pre_authorized']));
  });

  it('markCancelled with a pending reference records the pending cancel', async () => {
    h.results.push([{ id: 2 }]);
    await markCancelled(2, 'CXL1');
    expect(last().set).toMatchObject({
      status: 'cancelled',
      pendingOperation: 'cancel',
      pendingOperationRef: 'CXL1',
    });
    h.results.push([{ id: 2 }]);
    await markCancelled(2);
    expect(last().set).toMatchObject({
      pendingOperation: null,
      pendingOperationRef: null,
      pendingOperationAt: null,
    });
  });

  it('confirmOperation clears only the operation with the same reference and keeps the reference', async () => {
    h.results.push([{ id: 3 }]);
    expect(await confirmOperation(3, 'capture', 'CAP1')).toBe(true);
    expect(last().set).toMatchObject({ pendingOperation: null, pendingOperationAt: null });
    expect(last().set).not.toHaveProperty('pendingOperationRef');
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.id', value: 3 },
        { op: 'eq', col: 'pr.pending_operation', value: 'capture' },
        { op: 'eq', col: 'pr.pending_operation_ref', value: 'CAP1' },
      ],
    });
    expect(await confirmOperation(3, 'cancel', 'OTHER')).toBe(false);
  });

  it('failPendingCapture moves only the captured, unrefunded record of that capture', async () => {
    h.results.push([{ id: 4, status: 'failed' }]);
    expect(await failPendingCapture(4, 'CAP1', LONG)).toEqual({ id: 4, status: 'failed' });
    const call = last();
    expect(call.set).toMatchObject({
      status: 'failed',
      failureReason: LONG.slice(0, 500),
      pendingOperation: null,
      pendingOperationAt: null,
    });
    const where = call.where as { args: unknown[] };
    expect(where.args).toEqual([
      { op: 'eq', col: 'pr.id', value: 4 },
      { op: 'eq', col: 'pr.status', value: 'captured' },
      { op: 'eq', col: 'pr.pending_operation_ref', value: 'CAP1' },
      expect.objectContaining({ op: 'sql' }),
      { op: 'eq', col: 'pr.refunded_amount_cents', value: 0 },
    ]);
    expect((where.args[3] as { text: string }).text).toContain("IS NULL OR ? = 'capture'");
    expect(await failPendingCapture(4, 'CAP1', 'x')).toBeNull();
  });

  it('markAuthorisationEnded cancels an open hold with the reason', async () => {
    h.results.push([{ id: 5 }]);
    expect(await markAuthorisationEnded(5, 'Adyen authorisation expired')).toBe(true);
    expect(last().set).toMatchObject({
      status: 'cancelled',
      capturedAmountCents: 0,
      lastActionReason: 'Adyen authorisation expired',
    });
    expect(last().where).toEqual(guard(5, ['pre_authorized']));
  });

  it('markAuthorisationEnded clears a pending cancel of a record already cancelled', async () => {
    h.results.push([], [{ id: 5 }]);
    expect(await markAuthorisationEnded(5, 'expired')).toBe(true);
    expect(last().set).toMatchObject({ pendingOperation: null, pendingOperationAt: null });
    expect(last().where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.id', value: 5 },
        { op: 'eq', col: 'pr.pending_operation', value: 'cancel' },
      ],
    });
    h.results.push([], []);
    expect(await markAuthorisationEnded(5, 'expired')).toBe(false);
  });

  it('addPendingRefunds appends pending entries, skipping a listed refund id', async () => {
    h.results.push([{ refunds: [entry('RF1', 'pending')] }], [{ id: 9 }]);
    expect(
      await addPendingRefunds(
        9,
        [
          { refundId: 'RF1', paymentId: 'PSP1', amountCents: 500 },
          { refundId: 'RF2', paymentId: 'TOP1', amountCents: 300 },
        ],
        { actorUserId: 'u1', actionReason: 'Partial' },
      ),
    ).toEqual({ id: 9 });
    const set = last().set as { providerRefunds: Array<Record<string, unknown>> };
    expect(set.providerRefunds).toHaveLength(2);
    expect(set.providerRefunds[1]).toMatchObject({
      refundId: 'RF2',
      paymentId: 'TOP1',
      amountCents: 300,
      state: 'pending',
    });
    expect(last().set).toMatchObject({ lastActorUserId: 'u1', lastActionReason: 'Partial' });

    h.results.push([]);
    expect(await addPendingRefunds(10, [], {})).toBeNull();
  });

  it('settleRefund raises the total and the status once for a confirmed pending refund', async () => {
    h.results.push([locked()], [{ id: 9, status: 'partially_refunded' }]);
    const result = await settleRefund(9, {
      refundId: 'RF1',
      paymentId: 'PSP1',
      amountCents: 999,
      outcome: 'succeeded',
    });
    expect(result).toMatchObject({
      status: 'applied',
      record: { id: 9 },
      entry: { refundId: 'RF1', state: 'succeeded', amountCents: 500 },
    });
    const call = last();
    expect(call.set).toMatchObject({ status: 'partially_refunded', refundedAmountCents: 500 });
    expect(call.set).not.toHaveProperty('metadata');
    expect((call.set?.['providerRefunds'] as unknown[])[0]).toMatchObject({
      refundId: 'RF1',
      state: 'succeeded',
      settledAt: expect.any(String) as unknown,
    });
    expect(call.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'pr.id', value: 9 },
        { op: 'inArray', col: 'pr.status', values: ['captured', 'partially_refunded'] },
        { op: 'lte', col: 'pr.refunded_amount_cents', value: 500 },
      ],
    });
  });

  it('settleRefund marks the record refunded at the captured total and raises the top-up', async () => {
    h.results.push(
      [
        locked({
          capturedAmountCents: 1500,
          refundedAmountCents: 1000,
          metadata: { topUps: [{ paymentId: 'TOP1', amountCents: 500, refundedCents: 0 }] },
          providerRefunds: [entry('RF2', 'pending', 'TOP1', 500)],
        }),
      ],
      [{ id: 9, status: 'refunded' }],
    );
    await settleRefund(9, {
      refundId: 'RF2',
      paymentId: 'TOP1',
      amountCents: 500,
      outcome: 'succeeded',
    });
    const set = last().set as Record<string, unknown>;
    expect(set['status']).toBe('refunded');
    expect(set['refundedAmountCents']).toBe(1500);
    const metadata = set['metadata'] as { values: unknown[] };
    expect(metadata.values).toContain(
      JSON.stringify([{ paymentId: 'TOP1', amountCents: 500, refundedCents: 500 }]),
    );
  });

  it('settleRefund of one of two pending refunds settles only its entry', async () => {
    const both = [entry('RF1', 'pending', 'PSP1', 60), entry('RF2', 'pending', 'PSP1', 1940)];
    h.results.push([locked({ providerRefunds: both })], [{ id: 9 }]);
    await settleRefund(9, {
      refundId: 'RF2',
      paymentId: 'PSP1',
      amountCents: 1940,
      outcome: 'succeeded',
    });
    expect(last().set).toMatchObject({ status: 'partially_refunded', refundedAmountCents: 1940 });
    expect(last().set?.['providerRefunds']).toEqual([
      expect.objectContaining({ refundId: 'RF1', state: 'pending' }),
      expect.objectContaining({ refundId: 'RF2', state: 'succeeded' }),
    ]);

    h.results.push(
      [
        locked({
          status: 'partially_refunded',
          refundedAmountCents: 1940,
          providerRefunds: [both[0], { ...both[1], state: 'succeeded' }],
        }),
      ],
      [{ id: 9 }],
    );
    await settleRefund(9, {
      refundId: 'RF1',
      paymentId: 'PSP1',
      amountCents: 60,
      outcome: 'succeeded',
    });
    expect(last().set).toMatchObject({ status: 'refunded', refundedAmountCents: 2000 });
    expect(last().set?.['providerRefunds']).toEqual([
      expect.objectContaining({ refundId: 'RF1', state: 'succeeded' }),
      expect.objectContaining({ refundId: 'RF2', state: 'succeeded' }),
    ]);
  });

  it('settleRefund applies a duplicate once', async () => {
    h.results.push([locked({ providerRefunds: [entry('RF1', 'succeeded')] })]);
    expect(
      await settleRefund(9, {
        refundId: 'RF1',
        paymentId: 'PSP1',
        amountCents: 500,
        outcome: 'succeeded',
      }),
    ).toEqual({ status: 'already_settled' });
    expect(h.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('settleRefund marks a failed refund in the ledger without touching the totals', async () => {
    h.results.push([locked()], [{ id: 9, status: 'captured' }]);
    const result = await settleRefund(9, {
      refundId: 'RF1',
      paymentId: 'PSP1',
      amountCents: 500,
      outcome: 'failed',
    });
    expect(result).toMatchObject({ status: 'applied', entry: { state: 'failed' } });
    expect(last().set).not.toHaveProperty('refundedAmountCents');
    expect(last().set).not.toHaveProperty('status');
  });

  it('settleRefund appends a refund made outside EVtivity', async () => {
    h.results.push([locked({ providerRefunds: [] })], [{ id: 9 }]);
    await settleRefund(9, {
      refundId: 'CA1',
      paymentId: 'PSP1',
      amountCents: 700,
      outcome: 'succeeded',
    });
    expect(last().set).toMatchObject({ refundedAmountCents: 700 });
    expect(last().set?.['providerRefunds']).toEqual([
      expect.objectContaining({ refundId: 'CA1', amountCents: 700, state: 'succeeded' }),
    ]);
  });

  it('settleRefund keeps the totals of a record that cannot take the refund', async () => {
    h.results.push([locked({ status: 'failed' })], [{ id: 9 }]);
    expect(
      await settleRefund(9, {
        refundId: 'RF1',
        paymentId: 'PSP1',
        amountCents: 500,
        outcome: 'succeeded',
      }),
    ).toEqual({ status: 'not_refundable', recordStatus: 'failed' });
    expect(last().set).not.toHaveProperty('refundedAmountCents');

    h.results.push([locked({ refundedAmountCents: 1800 })], [{ id: 9 }]);
    expect(
      await settleRefund(9, {
        refundId: 'RF1',
        paymentId: 'PSP1',
        amountCents: 500,
        outcome: 'succeeded',
      }),
    ).toMatchObject({ status: 'not_refundable' });
  });

  it('settleRefund returns not_found for an unknown record', async () => {
    h.results.push([]);
    expect(
      await settleRefund(1, { refundId: 'x', paymentId: 'y', amountCents: 1, outcome: 'failed' }),
    ).toEqual({ status: 'not_found' });
  });

  it('recordsAwaitingConfirmation reads old pending operations and old pending refunds', async () => {
    h.results.push([{ id: 1 }]);
    const olderThan = new Date('2026-10-02T00:00:00Z');
    const since = new Date('2026-07-01T00:00:00Z');
    expect(await recordsAwaitingConfirmation(olderThan, since, 50)).toEqual([{ id: 1 }]);
    const where = last().where as { text: string; values: unknown[] };
    expect(where.text).toContain('IS NOT NULL AND ? < ?');
    expect(where.text).toContain("r ->> 'state' = 'pending'");
    expect(where.values).toContain(olderThan);
    expect(where.values).toContain(since);
    expect(last().limit).toBe(50);
  });
});

describe('settlePrepaidSession for a re-bill', () => {
  it('debits the given cost and marks the record as the re-bill', async () => {
    h.getCompanyCurrency.mockResolvedValue('EUR');
    h.writeAudit.mockResolvedValue(undefined);
    h.results.push(
      [
        {
          tokenId: 't1',
          tokenDriverId: 'd1',
          balanceCents: 5000,
          driverId: 'd1',
          finalCostCents: 0,
          currency: 'EUR',
        },
      ],
      [{ id: 9 }],
      [{ balanceCents: 4100 }],
    );
    expect(await settlePrepaidSession('s1', undefined, { costCents: 900, rebill: true })).toEqual({
      tokenId: 't1',
      debitedCents: 900,
      balanceCents: 4100,
    });
    const insert = h.calls.find((c) => c.kind === 'insert');
    expect(insert?.values?.['capturedAmountCents']).toBe(900);
    expect(insert?.values?.['metadata']).toEqual({
      tokenId: 't1',
      rebill: { requestedAt: expect.any(String) as string },
    });
  });
});

describe('claimRebillRecord', () => {
  const request = {
    provider: 'stripe' as const,
    customerId: 'cus_1',
    methodId: 'pm_1',
    grossCents: 1190,
    currency: 'EUR',
    feeTaxRate: 0.19,
    platformFeePercent: 10,
    payoutAccountId: 'acct_1',
  };
  const input = { sessionId: 's1', driverId: 'd1', sitePaymentConfigId: 3, request };
  const held = [{ id: 's1' }];
  const cancelledHold = {
    id: 7,
    status: 'cancelled',
    provider: 'stripe',
    providerPaymentId: 'pi_hold',
    capturedAmountCents: 0,
    refundedAmountCents: 0,
    pendingOperation: null,
    providerRefunds: [],
    failureReason: null,
    metadata: null,
  };
  const hoursAgo = (hours: number): string =>
    new Date(Date.now() - hours * 3_600_000).toISOString();

  it('inserts a pending record with the request when the session has none', async () => {
    h.results.push(held, [], [{ id: 11 }]);
    expect(await claimRebillRecord(input)).toEqual({
      state: 'claimed',
      id: 11,
      request,
      resumed: false,
    });
    const [session, lock, insert] = h.calls;
    expect(session?.lock).toBe('share');
    expect(session?.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'cs.id', value: 's1' },
        { op: 'eq', col: 'cs.status', value: 'faulted' },
        { op: 'eq', col: 'cs.stopped_reason', value: 'EndRequestFailed' },
        { op: 'eq', col: 'cs.rebill_status', value: 'in_progress' },
      ],
    });
    expect(lock?.lock).toBe('update');
    expect(insert?.values).toMatchObject({
      sessionId: 's1',
      driverId: 'd1',
      sitePaymentConfigId: 3,
      provider: 'stripe',
      providerPaymentId: null,
      providerCustomerId: 'cus_1',
      providerPaymentMethodId: 'pm_1',
      paymentSource: 'operator',
      currency: 'EUR',
      status: 'pending',
      metadata: { rebill: { requestedAt: expect.any(String) as string, request } },
    });
    expect(insert?.conflict).toEqual({ target: 'pr.session_id' });
  });

  it('writes nothing when the session is no longer faulted with its claim held (P11)', async () => {
    h.results.push([]);
    expect(await claimRebillRecord(input)).toEqual({ state: 'session_not_claimed' });
    expect(h.calls).toHaveLength(1);
  });

  it('refuses when a concurrent insert won', async () => {
    h.results.push(held, [], []);
    expect(await claimRebillRecord(input)).toEqual({ state: 'refused', status: 'pending' });
  });

  it('takes over a cancelled hold that took no money, keeping its ids', async () => {
    h.results.push(held, [cancelledHold], [{ id: 7 }]);
    expect(await claimRebillRecord(input)).toEqual({
      state: 'claimed',
      id: 7,
      request,
      resumed: false,
    });
    const update = h.calls.find((c) => c.kind === 'update');
    expect(update?.set).toMatchObject({
      status: 'pending',
      provider: 'stripe',
      providerPaymentId: null,
      paymentSource: 'operator',
      capturedAmountCents: null,
      pendingOperation: null,
    });
    const metadata = update?.set?.['metadata'] as { values: unknown[] };
    expect(String(metadata.values[1])).toContain('"previousPaymentId":"pi_hold"');
    expect(String(metadata.values[1])).toContain('"grossCents":1190');
    expect(update?.where).toEqual(guard(7, ['cancelled', 'failed']));
  });

  it.each([
    [{ ...cancelledHold, status: 'pre_authorized' }],
    [{ ...cancelledHold, status: 'captured', capturedAmountCents: 500 }],
    [{ ...cancelledHold, pendingOperation: 'cancel' }],
    [{ ...cancelledHold, status: 'failed', refundedAmountCents: 1 }],
  ])('refuses a record that holds another payment (%j)', async (record) => {
    h.results.push(held, [record]);
    expect(await claimRebillRecord(input)).toEqual({ state: 'refused', status: record.status });
    expect(h.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('reports the state of a record the re-bill already wrote', async () => {
    const stored = { ...request, grossCents: 900 };
    const marked = {
      ...cancelledHold,
      providerPaymentId: null,
      metadata: { rebill: { requestedAt: hoursAgo(1), request: stored } },
    };
    h.results.push(held, [{ ...marked, status: 'pending' }]);
    expect(await claimRebillRecord(input)).toEqual({
      state: 'claimed',
      id: 7,
      request: stored,
      resumed: true,
    });
    h.results.push(held, [{ ...marked, status: 'captured', capturedAmountCents: 900 }]);
    expect(await claimRebillRecord(input)).toEqual({ state: 'charged', id: 7, amountCents: 900 });
    h.results.push(held, [{ ...marked, status: 'failed', failureReason: 'declined' }]);
    expect(await claimRebillRecord(input)).toEqual({
      state: 'failed',
      id: 7,
      reason: 'declined',
      amountCents: 900,
    });
    h.results.push(held, [{ ...marked, status: 'refunded' }]);
    expect(await claimRebillRecord(input)).toEqual({ state: 'refused', status: 'refunded' });
    expect(h.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('refuses to resume a charge without an answer for REBILL_RESUME_MAX_HOURS', async () => {
    h.results.push(held, [
      {
        ...cancelledHold,
        status: 'pending',
        providerPaymentId: null,
        metadata: { rebill: { requestedAt: hoursAgo(REBILL_RESUME_MAX_HOURS), request } },
      },
    ]);
    expect(await claimRebillRecord(input)).toEqual({ state: 'refused', status: 'pending' });
  });

  it('stores the request on a pending re-bill record that has none', async () => {
    h.results.push(
      held,
      [{ ...cancelledHold, status: 'pending', metadata: { rebill: { requestedAt: hoursAgo(1) } } }],
      [],
    );
    expect(await claimRebillRecord(input)).toEqual({
      state: 'claimed',
      id: 7,
      request,
      resumed: false,
    });
    const update = h.calls.find((c) => c.kind === 'update');
    expect(String((update?.set?.['metadata'] as { values: unknown[] }).values[1])).toContain(
      '"grossCents":1190',
    );
  });

  it('isStaleRebillCharge and rebillChargeRequest read the marker', () => {
    const pending = {
      status: 'pending',
      providerPaymentId: null,
      metadata: { rebill: { requestedAt: hoursAgo(REBILL_RESUME_MAX_HOURS + 1), request } },
    };
    expect(isStaleRebillCharge(pending)).toBe(true);
    expect(isStaleRebillCharge({ ...pending, providerPaymentId: 'pi_1' })).toBe(false);
    expect(isStaleRebillCharge({ ...pending, status: 'captured' })).toBe(false);
    expect(
      isStaleRebillCharge({ ...pending, metadata: { rebill: { requestedAt: hoursAgo(22) } } }),
    ).toBe(false);
    expect(isStaleRebillCharge({ ...pending, metadata: null })).toBe(false);
    expect(rebillChargeRequest(pending)).toEqual(request);
    expect(
      rebillChargeRequest({ metadata: { rebill: { request: { grossCents: 1 } } } }),
    ).toBeNull();
    expect(REBILL_RESUME_MAX_HOURS).toBeLessThan(24);
  });

  it('isRebillRecord reads the marker', () => {
    expect(isRebillRecord({ metadata: { rebill: {} } })).toBe(true);
    expect(isRebillRecord({ metadata: { tokenId: 't1' } })).toBe(false);
    expect(isRebillRecord({ metadata: null })).toBe(false);
  });
});

describe('invoice claims of reservation fee charges', () => {
  it('claims only unclaimed fee records and returns the ids it claimed', async () => {
    h.results.push([{ id: 7 }]);

    const claimed = await claimFeeRecordsForInvoice(h.db as never, [7, 8], 'inv_1');

    expect(claimed).toEqual([7]);
    expect(last()).toMatchObject({
      kind: 'update',
      set: { invoiceId: 'inv_1' },
      where: {
        op: 'and',
        args: [
          { op: 'inArray', col: 'pr.id', values: [7, 8] },
          { op: 'isNull', col: 'pr.invoice_id' },
        ],
      },
    });
  });

  it('claims nothing without fee records', async () => {
    expect(await claimFeeRecordsForInvoice(h.db as never, [], 'inv_1')).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('releases the fee records of a voided invoice', async () => {
    h.results.push([{ id: 7 }, { id: 9 }]);

    const released = await releaseInvoiceFeeRecords(h.db as never, 'inv_1');

    expect(released).toEqual([7, 9]);
    expect(last()).toMatchObject({
      kind: 'update',
      set: { invoiceId: null },
      where: { op: 'eq', col: 'pr.invoice_id', value: 'inv_1' },
    });
  });
});
