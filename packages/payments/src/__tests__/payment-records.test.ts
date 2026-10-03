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
  },
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
    stripePaymentIntentId: 'pr.stripe_payment_intent_id',
    createdAt: 'pr.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
  inArray: (col: unknown, values: unknown) => ({ op: 'inArray', col, values }),
  lte: (col: unknown, value: unknown) => ({ op: 'lte', col, value }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

import {
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
      stripePaymentIntentId: 'pi_1',
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_1',
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
    expect(call.values).not.toHaveProperty('stripePaymentIntentId');
    expect(call.conflict).toEqual({ target: 'pr.session_id' });
  });

  it('recordFailedHold returns null on conflict', async () => {
    h.results.push([]);
    expect(
      await recordFailedHold({
        sessionId: 's1',
        driverId: null,
        sitePaymentConfigId: null,
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
      stripePaymentIntentId: 'pi_g',
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
      customerId: 'cus_1',
      methodId: 'pm_1',
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
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_1',
      paymentSource: 'web_portal',
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
    expect(await findByPaymentId('pi_3')).toEqual({ id: 3 });
    expect(last().where).toEqual({ op: 'eq', col: 'pr.stripe_payment_intent_id', value: 'pi_3' });
    expect(await findByPaymentId('pi_3')).toBeNull();
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
    expect(await findByChargePaymentId('pi_3')).toEqual({ id: 3 });
    expect(h.calls.filter((c) => c.kind === 'select')).toHaveLength(1);

    h.calls.length = 0;
    h.results.push([], [{ id: 4 }]);
    expect(await findByChargePaymentId('pi_top')).toEqual({ id: 4 });
    const where = last().where as { op: string; args: Array<{ text: string; values: unknown[] }> };
    expect(where.op).toBe('or');
    expect(where.args[0]?.text).toContain("-> 'topUps' @>");
    expect(where.args[0]?.values).toContain(JSON.stringify([{ paymentId: 'pi_top' }]));
    expect(where.args[1]?.text).toContain("->> 'topUpIntentId' =");
    expect(last().limit).toBe(1);

    h.results.push([], []);
    expect(await findByChargePaymentId('pi_none')).toBeNull();
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
        { op: 'sql', text: '? IS NOT NULL', values: ['pr.stripe_payment_intent_id'] },
        { op: 'sql', text: "? <> ''", values: ['pr.stripe_payment_intent_id'] },
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
    expect(await markChargeCaptured(4, { paymentId: 'pi_4', amountCents: 900 })).toBe(true);
    expect(last().set).toMatchObject({
      status: 'captured',
      stripePaymentIntentId: 'pi_4',
      capturedAmountCents: 900,
    });
    expect(last().where).toEqual(guard(4, ['pending']));
    expect(await markChargeCaptured(4, { paymentId: 'pi_4', amountCents: 900 })).toBe(false);
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

  it('markRefunded replaces metadata.topUps and drops a legacy topUpIntentId', async () => {
    h.results.push([{ id: 8 }]);
    const topUps = [{ paymentId: 'pi_top', amountCents: 600, refundedCents: 600 }];
    await markRefunded(8, { refundedTotalCents: 2600, full: true, topUps });
    const metadata = last().set?.['metadata'] as { text: string; values: unknown[] };
    expect(metadata.text).toContain("- 'topUpIntentId', '{topUps}'");
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

  it('returns null without a debit when the session was already settled', async () => {
    h.results.push([ROW], []);
    expect(await settlePrepaidSession('s1', logger)).toBeNull();
    expect(h.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it.each([[[]], [[{ balanceCents: null }]]])(
    'returns null when the balance update returns nothing (%j)',
    async (updated) => {
      h.results.push([ROW], [{ id: 9 }], updated);
      expect(await settlePrepaidSession('s1', logger)).toBeNull();
      expect(h.writeAudit).not.toHaveBeenCalled();
    },
  );
});
