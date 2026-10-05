// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    // Queued select results per table, consumed in query order.
    selectQueues: {} as Record<string, unknown[][]>,
    // Rows inserted per table.
    inserted: {} as Record<string, unknown[]>,
    // When set, the invoices insert returns no row.
    failInvoiceInsert: false,
  };

  // Tables are tagged objects so the db mock can answer per table.
  const table = (name: string) => ({ __table: name });

  function selectChain() {
    let tableName = '';
    const chain: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'groupBy']) {
      chain[m] = vi.fn(() => chain);
    }
    chain['from'] = vi.fn((t: { __table: string }) => {
      tableName = t.__table;
      return chain;
    });
    chain['then'] = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) => {
      const result = state.selectQueues[tableName]?.shift() ?? [];
      return Promise.resolve(result).then(onFulfilled, onRejected);
    };
    return chain;
  }

  function insertChain(t: { __table: string }) {
    let rows: Array<Record<string, unknown>> = [];
    const chain: Record<string, unknown> = {};
    chain['values'] = vi.fn((v: Record<string, unknown> | Array<Record<string, unknown>>) => {
      rows = Array.isArray(v) ? v : [v];
      state.inserted[t.__table] = [...(state.inserted[t.__table] ?? []), ...rows];
      return chain;
    });
    chain['returning'] = vi.fn(() => {
      if (t.__table === 'invoices') {
        return Promise.resolve(
          state.failInvoiceInsert ? [] : rows.map((r) => ({ id: 'inv_1', ...r })),
        );
      }
      return Promise.resolve(rows.map((r, i) => ({ id: i + 1, ...r })));
    });
    return chain;
  }

  function updateChain() {
    const chain: Record<string, unknown> = {};
    chain['set'] = vi.fn(() => chain);
    chain['where'] = vi.fn(() => chain);
    chain['returning'] = vi.fn(() => Promise.resolve(state.selectQueues['update']?.shift() ?? []));
    return chain;
  }

  return { state, table, selectChain, insertChain, updateChain };
});

function queue(tableName: string, ...results: unknown[][]): void {
  h.state.selectQueues[tableName] = [...(h.state.selectQueues[tableName] ?? []), ...results];
}

vi.mock('@evtivity/database', () => {
  const db = {
    select: vi.fn(() => h.selectChain()),
    insert: vi.fn((t: { __table: string }) => h.insertChain(t)),
    update: vi.fn(() => h.updateChain()),
    execute: vi.fn(() => Promise.resolve([{ seq: '42' }])),
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return {
    db,
    invoices: h.table('invoices'),
    invoiceLineItems: h.table('invoiceLineItems'),
    chargingSessions: h.table('chargingSessions'),
    drivers: h.table('drivers'),
    paymentRecords: h.table('paymentRecords'),
    getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  between: vi.fn(),
  asc: vi.fn(),
  ne: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@evtivity/services/company-currency', () => ({
  inCompanyCurrency: vi.fn(),
  sessionCurrencySql: vi.fn(),
}));

import {
  calculateSessionCost,
  calculateSplitSessionCost,
  chargedCostBreakdown,
  toSessionCostBreakdown,
} from '@evtivity/lib';
import type { TariffInput, TaxBasis } from '@evtivity/lib';
import {
  generateInvoiceNumber,
  createSessionInvoice,
  createAggregatedInvoice,
  getInvoice,
  voidInvoice,
  isSessionCollected,
  invoiceStatusFor,
} from '../services/invoice.service.js';

const ENDED = new Date('2026-06-04T11:00:00Z');

function tariff(pricePerKwh: string, taxRate: string, extra: Partial<TariffInput> = {}) {
  return {
    pricePerKwh,
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate,
    ...extra,
  };
}

/** The breakdown session-pricing stores for a single-tariff session, as read back from jsonb. */
function stored(
  t: TariffInput,
  energyWh: number,
  holdingMinutes = 0,
  basis: TaxBasis = 'net',
): unknown {
  return JSON.parse(
    JSON.stringify(
      toSessionCostBreakdown(calculateSessionCost(t, energyWh, 60, 0, 0, holdingMinutes, basis)),
    ),
  ) as unknown;
}

/** The breakdown stored for a split session: 10 kWh at 19%, then 5 kWh at 7%. */
function storedSplit(): unknown {
  return toSessionCostBreakdown(
    calculateSplitSessionCost(
      [
        {
          tariff: tariff('0.30', '0.19'),
          durationMinutes: 30,
          energyDeliveredWh: 10_000,
          idleMinutes: 0,
          isFirstSegment: true,
        },
        {
          tariff: tariff('0.30', '0.07'),
          durationMinutes: 30,
          energyDeliveredWh: 5_000,
          idleMinutes: 0,
          isFirstSegment: false,
        },
      ],
      0,
    ),
  );
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ses_1',
    driverId: 'drv_1',
    energyDeliveredWh: '10000',
    endedAt: ENDED,
    tariffTaxRate: '0.19',
    // 10 kWh at 0.30 net, 19%: 300 + 57.
    costBreakdown: stored(tariff('0.30', '0.19'), 10_000),
    finalCostCents: 357,
    currency: 'EUR',
    status: 'completed',
    ...overrides,
  };
}

type LineRow = {
  description: string;
  totalCents: number;
  taxCents: number;
  taxRate: string;
  metadata: Record<string, unknown>;
  sessionId: string | null;
  paymentRecordId?: number | null;
};

function insertedLines(): LineRow[] {
  return (h.state.inserted['invoiceLineItems'] ?? []) as LineRow[];
}

function insertedInvoice(): Record<string, number | string> {
  return (h.state.inserted['invoices'] ?? [])[0] as Record<string, number | string>;
}

beforeEach(() => {
  h.state.selectQueues = {};
  h.state.inserted = {};
  h.state.failInvoiceInsert = false;
});

describe('generateInvoiceNumber', () => {
  it('formats INV-YYYYMM-NNNN from the sequence', async () => {
    const result = await generateInvoiceNumber();
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    expect(result).toBe(`INV-${String(now.getFullYear())}${month}-0042`);
  });
});

describe('createSessionInvoice', () => {
  it('bills each stored component at its rate and totals the charged amount', async () => {
    // 10 kWh at 0.30 = 300, session fee 100: subtotal 400, tax round(76) = 76.
    queue('chargingSessions', [
      session({
        costBreakdown: stored(tariff('0.30', '0.19', { pricePerSession: '1.00' }), 10_000),
        finalCostCents: 476,
      }),
    ]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(
      insertedLines().map((l) => [l.metadata['kind'], l.totalCents, l.taxCents, l.taxRate]),
    ).toEqual([
      ['energy', 300, 57, '0.19'],
      ['sessionFee', 100, 19, '0.19'],
    ]);
    expect(insertedInvoice()).toMatchObject({
      subtotalCents: 400,
      taxCents: 76,
      totalCents: 476,
      currency: 'EUR',
      driverId: 'drv_1',
    });
  });

  it('no longer adds a separate tax line item', async () => {
    queue('chargingSessions', [session()]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedLines().map((l) => l.description)).toEqual(['Energy charge']);
  });

  it('bills the stored reservation holding fee', async () => {
    // Held 10 minutes at 0.10: 100 net, 19 tax.
    queue('chargingSessions', [
      session({
        costBreakdown: stored(
          tariff('0.30', '0.19', { reservationFeePerMinute: '0.10' }),
          10_000,
          10,
        ),
        finalCostCents: 357 + 119,
      }),
    ]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedLines().map((l) => [l.metadata['kind'], l.totalCents, l.taxCents])).toEqual([
      ['energy', 300, 57],
      ['reservationFee', 100, 19],
    ]);
    expect(insertedInvoice()['totalCents']).toBe(476);
  });

  it('itemizes a split session per segment at each segment rate', async () => {
    // Segment 1: 10 kWh at 0.30, 19% -> 300 + 57. Segment 2: 5 kWh at 0.30, 7% -> 150 + 11.
    queue('chargingSessions', [session({ costBreakdown: storedSplit(), finalCostCents: 518 })]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(
      insertedLines().map((l) => [l.description, l.metadata, l.totalCents, l.taxCents, l.taxRate]),
    ).toEqual([
      ['Segment 1 energy charge', { kind: 'energy', segment: 1 }, 300, 57, '0.19'],
      ['Segment 2 energy charge', { kind: 'energy', segment: 2 }, 150, 11, '0.07'],
    ]);
    expect(insertedInvoice()).toMatchObject({ subtotalCents: 450, taxCents: 68, totalCents: 518 });
  });

  it('bills a split session with one rate at the tax the session charged for that rate', async () => {
    // Three segments of 1 kWh at 0.33, 19%: 33 net each. Tax rounded once on
    // 99: 18.81 -> 19 (per segment it was 6 + 6 + 6 = 18). The lines carry
    // the session's shares of it: 6.27 each, so 7, 6, 6.
    const segment = (first: boolean) => ({
      tariff: tariff('0.33', '0.19'),
      durationMinutes: 20,
      energyDeliveredWh: 1_000,
      idleMinutes: 0,
      isFirstSegment: first,
    });
    const breakdown = toSessionCostBreakdown(
      calculateSplitSessionCost([segment(true), segment(false), segment(false)], 0),
    );
    expect(breakdown.taxLines).toEqual([{ taxRate: 0.19, netCents: 99, taxCents: 19 }]);
    queue('chargingSessions', [session({ costBreakdown: breakdown, finalCostCents: 118 })]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedLines().map((l) => [l.metadata['segment'], l.totalCents, l.taxCents])).toEqual([
      [1, 33, 7],
      [2, 33, 6],
      [3, 33, 6],
    ]);
    expect(insertedInvoice()).toMatchObject({ subtotalCents: 99, taxCents: 19, totalCents: 118 });
  });

  it('prints gross-basis lines whose net plus tax is each gross amount charged', async () => {
    // Gross prices: 10 kWh at 0.357 = 357, session fee 1.19 = 119. 476 gross, 400 net.
    queue('chargingSessions', [
      session({
        costBreakdown: stored(
          tariff('0.357', '0.19', { pricePerSession: '1.19' }),
          10_000,
          0,
          'gross',
        ),
        finalCostCents: 476,
      }),
    ]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(
      insertedLines().map((l) => [l.metadata['kind'], l.totalCents + l.taxCents, l.taxCents]),
    ).toEqual([
      ['energy', 357, 57],
      ['sessionFee', 119, 19],
    ]);
    expect(insertedInvoice()).toMatchObject({ subtotalCents: 400, taxCents: 76, totalCents: 476 });
  });

  it('writes one line per rate for a breakdown without components (backfilled sessions)', async () => {
    queue('chargingSessions', [
      session({ costBreakdown: chargedCostBreakdown(400, 0.19, 'net'), finalCostCents: 400 }),
    ]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedLines()).toHaveLength(1);
    expect(insertedLines()[0]).toMatchObject({
      totalCents: 336,
      taxCents: 64,
      taxRate: '0.19',
      metadata: { kind: 'session', sessionDate: '2026-06-04', energyWh: 10_000 },
    });
    expect(insertedInvoice()).toMatchObject({ subtotalCents: 336, taxCents: 64, totalCents: 400 });
  });

  it('splits the charged amount at the snapshot rate when no breakdown is stored for it', async () => {
    // The stored breakdown is for 357, the session was charged 400.
    queue('chargingSessions', [session({ finalCostCents: 400 })]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedLines().map((l) => [l.taxRate, l.totalCents, l.taxCents])).toEqual([
      ['0.19', 336, 64],
    ]);
    expect(insertedInvoice()['totalCents']).toBe(400);
  });

  it('bills a session without a tariff as one untaxed line', async () => {
    queue('chargingSessions', [
      session({
        tariffTaxRate: null,
        costBreakdown: chargedCostBreakdown(1500, 0, 'net'),
        finalCostCents: 1500,
      }),
    ]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedLines()).toHaveLength(1);
    expect(insertedLines()[0]).toMatchObject({ totalCents: 1500, taxCents: 0, taxRate: '0' });
    expect(insertedInvoice()).toMatchObject({ subtotalCents: 1500, taxCents: 0, totalCents: 1500 });
  });

  it('keeps one zero line for a session charged nothing', async () => {
    queue('chargingSessions', [
      session({
        energyDeliveredWh: '0',
        costBreakdown: chargedCostBreakdown(0, 0.19, 'net'),
        finalCostCents: 0,
      }),
    ]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedLines()).toHaveLength(1);
    expect(insertedLines()[0]).toMatchObject({ totalCents: 0, taxCents: 0 });
  });

  it('is paid when the session was captured for its final cost', async () => {
    queue('chargingSessions', [session({ paymentStatus: 'captured', paymentCapturedCents: 357 })]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedInvoice()['status']).toBe('paid');
  });

  it('is issued when the session has no payment record', async () => {
    queue('chargingSessions', [session({ paymentStatus: null, paymentCapturedCents: null })]);
    queue('invoiceLineItems', []);

    await createSessionInvoice('ses_1');

    expect(insertedInvoice()['status']).toBe('issued');
  });

  it('throws when the session is not found', async () => {
    queue('chargingSessions', []);
    await expect(createSessionInvoice('missing')).rejects.toThrow('Session not found');
  });

  it('throws when the session is not completed', async () => {
    queue('chargingSessions', [session({ status: 'active' })]);
    await expect(createSessionInvoice('ses_1')).rejects.toThrow('Session is not completed');
  });

  it('throws when a completed session has no final cost', async () => {
    queue('chargingSessions', [session({ finalCostCents: null })]);
    await expect(createSessionInvoice('ses_1')).rejects.toThrow('no finalCostCents');
  });

  it('throws when the session is already invoiced', async () => {
    queue('chargingSessions', [session()]);
    queue('invoiceLineItems', [{ id: 7 }]);
    await expect(createSessionInvoice('ses_1')).rejects.toThrow('already invoiced');
    expect(h.state.inserted['invoices']).toBeUndefined();
  });

  it('throws when the invoice insert returns no row', async () => {
    h.state.failInvoiceInsert = true;
    queue('chargingSessions', [session()]);
    queue('invoiceLineItems', []);
    await expect(createSessionInvoice('ses_1')).rejects.toThrow('Failed to create invoice');
  });
});

describe('createAggregatedInvoice', () => {
  const start = new Date('2026-06-01T00:00:00Z');
  const end = new Date('2026-06-30T23:59:59Z');

  it('splits each session by its stored tax lines and totals what the driver was charged', async () => {
    queue('chargingSessions', [
      session({
        id: 'ses_a',
        costBreakdown: chargedCostBreakdown(1190, 0.19, 'net'),
        finalCostCents: 1190,
      }),
      session({ id: 'ses_b', costBreakdown: storedSplit(), finalCostCents: 518 }),
      session({
        id: 'ses_c',
        tariffTaxRate: '0',
        costBreakdown: chargedCostBreakdown(250, 0, 'net'),
        finalCostCents: 250,
      }),
    ]);

    await createAggregatedInvoice('drv_1', start, end);

    expect(insertedLines().map((l) => [l.sessionId, l.taxRate, l.totalCents, l.taxCents])).toEqual([
      ['ses_a', '0.19', 1000, 190],
      ['ses_b', '0.07', 150, 11],
      ['ses_b', '0.19', 300, 57],
      ['ses_c', '0', 250, 0],
    ]);
    expect(insertedLines()[0]?.metadata).toEqual({
      kind: 'session',
      sessionDate: '2026-06-04',
      energyWh: 10_000,
    });
    expect(insertedInvoice()).toMatchObject({
      subtotalCents: 1700,
      taxCents: 258,
      totalCents: 1958,
      currency: 'EUR',
    });
  });

  it('keeps a zero line for a session charged nothing so it counts as invoiced', async () => {
    queue('chargingSessions', [
      session({ costBreakdown: chargedCostBreakdown(0, 0.19, 'net'), finalCostCents: 0 }),
    ]);

    await createAggregatedInvoice('drv_1', start, end);

    expect(insertedLines()).toHaveLength(1);
    expect(insertedInvoice()['totalCents']).toBe(0);
  });

  it('adds one line per reservation fee charged, at the rate it was taxed at', async () => {
    queue('chargingSessions', [session({ id: 'ses_a', finalCostCents: 1190 })]);
    queue('sessionTariffSegments', []);
    queue('paymentRecords', [
      {
        id: 7,
        chargeType: 'reservation_cancellation',
        capturedAmountCents: 595,
        taxRate: '0.19',
        createdAt: new Date('2026-06-05T08:00:00Z'),
      },
      {
        id: 8,
        chargeType: 'reservation_no_show',
        capturedAmountCents: 300,
        taxRate: '0',
        createdAt: new Date('2026-06-06T08:00:00Z'),
      },
    ]);

    await createAggregatedInvoice('drv_1', start, end);

    expect(
      insertedLines().map((l) => [
        l.sessionId,
        l.paymentRecordId,
        l.taxRate,
        l.totalCents,
        l.taxCents,
      ]),
    ).toEqual([
      ['ses_a', null, '0.19', 1000, 190],
      [null, 7, '0.19', 500, 95],
      [null, 8, '0', 300, 0],
    ]);
    expect(insertedLines()[1]?.metadata).toEqual({
      kind: 'cancellationFee',
      chargeDate: '2026-06-05',
    });
    expect(insertedLines()[2]?.metadata).toEqual({ kind: 'noShowFee', chargeDate: '2026-06-06' });
    expect(insertedInvoice()).toMatchObject({
      subtotalCents: 1800,
      taxCents: 285,
      totalCents: 2085,
    });
  });

  it('invoices reservation fees without sessions', async () => {
    queue('chargingSessions', []);
    queue('paymentRecords', [
      {
        id: 9,
        chargeType: 'reservation_cancellation',
        capturedAmountCents: 595,
        taxRate: '0.19',
        createdAt: new Date('2026-06-05T08:00:00Z'),
      },
    ]);

    await createAggregatedInvoice('drv_1', start, end);

    expect(insertedInvoice()).toMatchObject({ totalCents: 595, taxCents: 95 });
  });

  it('is paid when every session was captured and fees are captured charges', async () => {
    queue('chargingSessions', [
      session({ id: 'ses_a', paymentStatus: 'captured', paymentCapturedCents: 357 }),
      session({ id: 'ses_b', paymentStatus: 'partially_refunded', paymentCapturedCents: 400 }),
    ]);
    queue('paymentRecords', [
      {
        id: 7,
        chargeType: 'reservation_cancellation',
        capturedAmountCents: 595,
        taxRate: '0.19',
        createdAt: new Date('2026-06-05T08:00:00Z'),
      },
    ]);

    await createAggregatedInvoice('drv_1', start, end);

    expect(insertedInvoice()['status']).toBe('paid');
  });

  it('is issued when one session was not collected', async () => {
    queue('chargingSessions', [
      session({ id: 'ses_a', paymentStatus: 'captured', paymentCapturedCents: 357 }),
      session({ id: 'ses_b', paymentStatus: null, paymentCapturedCents: null }),
    ]);

    await createAggregatedInvoice('drv_1', start, end);

    expect(insertedInvoice()['status']).toBe('issued');
  });

  it('is paid for reservation fees alone', async () => {
    queue('chargingSessions', []);
    queue('paymentRecords', [
      {
        id: 9,
        chargeType: 'reservation_no_show',
        capturedAmountCents: 300,
        taxRate: '0',
        createdAt: new Date('2026-06-05T08:00:00Z'),
      },
    ]);

    await createAggregatedInvoice('drv_1', start, end);

    expect(insertedInvoice()['status']).toBe('paid');
  });

  it('throws INVOICE_NO_SESSIONS when nothing is left to invoice', async () => {
    queue('chargingSessions', []);
    await expect(createAggregatedInvoice('drv_1', start, end)).rejects.toMatchObject({
      code: 'INVOICE_NO_SESSIONS',
      statusCode: 400,
    });
  });

  it('throws when the invoice insert returns no row', async () => {
    h.state.failInvoiceInsert = true;
    queue('chargingSessions', [session()]);
    await expect(createAggregatedInvoice('drv_1', start, end)).rejects.toThrow(
      'Failed to create invoice',
    );
  });
});

describe('invoiceStatusFor', () => {
  it('counts a captured, partially refunded or refunded charge covering the cost as collected', () => {
    for (const paymentStatus of ['captured', 'partially_refunded', 'refunded']) {
      expect(
        isSessionCollected({ finalCostCents: 500, paymentStatus, paymentCapturedCents: 500 }),
      ).toBe(true);
    }
  });

  it('does not count a shortfall, a failed or pending payment, or no payment record', () => {
    expect(
      isSessionCollected({
        finalCostCents: 500,
        paymentStatus: 'captured',
        paymentCapturedCents: 400,
      }),
    ).toBe(false);
    for (const paymentStatus of ['failed', 'pending', 'pre_authorized', 'cancelled']) {
      expect(
        isSessionCollected({ finalCostCents: 500, paymentStatus, paymentCapturedCents: 500 }),
      ).toBe(false);
    }
    expect(isSessionCollected({ finalCostCents: 500 })).toBe(false);
  });

  it('counts a session that cost nothing as collected', () => {
    expect(isSessionCollected({ finalCostCents: 0 })).toBe(true);
  });

  it('is paid only when every session was collected', () => {
    const paid = { finalCostCents: 500, paymentStatus: 'captured', paymentCapturedCents: 500 };
    expect(invoiceStatusFor([])).toBe('paid');
    expect(invoiceStatusFor([paid, paid])).toBe('paid');
    expect(invoiceStatusFor([paid, { finalCostCents: 500 }])).toBe('issued');
  });
});

describe('getInvoice', () => {
  const invoice = { id: 'inv_1', driverId: 'drv_1', status: 'issued' };

  it('returns line items, the driver with language, and the tax breakdown per rate', async () => {
    queue('invoices', [invoice]);
    queue('invoiceLineItems', [
      { id: 1, totalCents: 300, taxCents: 57, taxRate: '0.19' },
      { id: 2, totalCents: 150, taxCents: 11, taxRate: '0.07' },
      { id: 3, totalCents: 100, taxCents: 19, taxRate: '0.1900' },
    ]);
    queue('drivers', [
      { id: 'drv_1', firstName: 'Ana', lastName: 'Diaz', email: 'a@x.test', language: 'de' },
    ]);

    const result = await getInvoice('inv_1');

    expect(result?.driver?.language).toBe('de');
    expect(result?.lineItems).toHaveLength(3);
    expect(result?.taxBreakdown).toEqual([
      { taxRate: 0.07, netCents: 150, taxCents: 11, grossCents: 161 },
      { taxRate: 0.19, netCents: 400, taxCents: 76, grossCents: 476 },
    ]);
  });

  it('returns a null driver without a driverId', async () => {
    queue('invoices', [{ ...invoice, driverId: null }]);
    queue('invoiceLineItems', []);
    const result = await getInvoice('inv_1');
    expect(result?.driver).toBeNull();
    expect(result?.taxBreakdown).toEqual([]);
  });

  it('returns null when the invoice does not exist', async () => {
    queue('invoices', []);
    expect(await getInvoice('missing')).toBeNull();
  });
});

describe('voidInvoice', () => {
  it('sets the status to void', async () => {
    queue('invoices', [{ id: 'inv_1', status: 'issued' }]);
    queue('update', [{ id: 'inv_1', status: 'void' }]);
    expect((await voidInvoice('inv_1'))?.status).toBe('void');
  });

  it('returns the invoice unchanged when already void', async () => {
    queue('invoices', [{ id: 'inv_1', status: 'void' }]);
    expect((await voidInvoice('inv_1'))?.status).toBe('void');
  });

  it('returns null when the invoice does not exist', async () => {
    queue('invoices', []);
    expect(await voidInvoice('missing')).toBeNull();
  });
});
