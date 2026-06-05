// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([{ seq: '1' }])),
  },
  invoices: {},
  invoiceLineItems: {},
  chargingSessions: {},
  tariffs: {},
  sessionTariffSegments: {},
  drivers: {},
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(5),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  between: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = 'AppError';
      this.statusCode = statusCode;
      this.code = code;
    }
  },
  calculateSessionCost: vi.fn().mockReturnValue({
    energyCostCents: 500,
    timeCostCents: 200,
    sessionFeeCents: 100,
    idleFeeCents: 0,
    subtotalCents: 800,
    taxCents: 64,
    totalCents: 864,
    currency: 'USD',
  }),
  calculateSplitSessionCost: vi.fn().mockReturnValue({
    energyCostCents: 600,
    timeCostCents: 300,
    sessionFeeCents: 200,
    idleFeeCents: 0,
    subtotalCents: 1100,
    taxCents: 88,
    totalCents: 1188,
    currency: 'USD',
  }),
}));

import {
  generateInvoiceNumber,
  createSessionInvoice,
  createAggregatedInvoice,
  getInvoice,
  voidInvoice,
} from '../services/invoice.service.js';
import { calculateSessionCost } from '@evtivity/lib';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

describe('Invoice Service', () => {
  describe('generateInvoiceNumber', () => {
    it('returns correct format INV-YYYYMM-NNNN using PostgreSQL sequence', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ seq: '1' }]);

      const result = await generateInvoiceNumber();

      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      expect(result).toBe(`INV-${String(year)}${month}-0001`);
    });

    it('pads sequence number to 4 digits', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ seq: '42' }]);

      const result = await generateInvoiceNumber();

      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      expect(result).toBe(`INV-${String(year)}${month}-0042`);
    });
  });

  describe('createSessionInvoice', () => {
    it('creates invoice using finalCostCents as the authoritative total', async () => {
      const sessionId = 'session-123';
      const invoiceId = 'invoice-456';
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');

      setupDbResults(
        // 1. session query
        [
          {
            id: sessionId,
            driverId: 'driver-789',
            tariffId: 'tariff-abc',
            energyDeliveredWh: '10000',
            startedAt: new Date(now.getTime() - 3600000),
            endedAt: now,
            finalCostCents: 864,
            currency: 'USD',
            status: 'completed',
            idleMinutes: '0',
            tariffPricePerKwh: '0.25',
            tariffPricePerMinute: '0.05',
            tariffPricePerSession: '1.00',
            tariffIdleFeePricePerMinute: null,
            tariffTaxRate: '0.08',
          },
        ],
        // 2. session tariff segments query (no segments = single tariff)
        [],
        // 3. insert invoice returning (generateInvoiceNumber uses db.execute, not chained queries)
        [
          {
            id: invoiceId,
            invoiceNumber: `INV-${String(year)}${month}-0001`,
            driverId: 'driver-789',
            status: 'issued',
            issuedAt: now,
            dueAt: new Date(now.getTime() + 30 * 86400000),
            currency: 'USD',
            subtotalCents: 800,
            taxCents: 64,
            totalCents: 864,
            metadata: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        // 4. insert line items returning
        [
          { id: 'li-1', description: 'Energy charge', totalCents: 500 },
          { id: 'li-2', description: 'Time charge', totalCents: 200 },
          { id: 'li-3', description: 'Session fee', totalCents: 100 },
          { id: 'li-4', description: 'Tax', totalCents: 64, taxCents: 64 },
        ],
      );

      const result = await createSessionInvoice(sessionId);

      expect(result.invoice.id).toBe(invoiceId);
      expect(result.invoice.status).toBe('issued');
      expect(result.invoice.totalCents).toBe(864);
      expect(result.lineItems).toHaveLength(4);
    });

    it('throws when session is not found', async () => {
      setupDbResults([]);

      await expect(createSessionInvoice('nonexistent')).rejects.toThrow('Session not found');
    });

    it('throws when session is not completed', async () => {
      setupDbResults([
        {
          id: 'session-123',
          driverId: 'driver-789',
          tariffId: null,
          energyDeliveredWh: null,
          startedAt: new Date(),
          endedAt: null,
          finalCostCents: null,
          currency: 'USD',
          status: 'active',
          idleMinutes: '0',
          tariffPricePerKwh: null,
          tariffPricePerMinute: null,
          tariffPricePerSession: null,
          tariffIdleFeePricePerMinute: null,
          tariffTaxRate: null,
        },
      ]);

      await expect(createSessionInvoice('session-123')).rejects.toThrow('Session is not completed');
    });

    it('throws when a completed session has no finalCostCents', async () => {
      setupDbResults([
        {
          id: 'session-x',
          driverId: 'd1',
          tariffId: null,
          energyDeliveredWh: '1000',
          startedAt: new Date(),
          endedAt: new Date(),
          finalCostCents: null,
          currency: 'USD',
          status: 'completed',
          idleMinutes: '0',
          tariffPricePerKwh: null,
          tariffPricePerMinute: null,
          tariffPricePerSession: null,
          tariffIdleFeePricePerMinute: null,
          tariffTaxRate: null,
        },
      ]);

      await expect(createSessionInvoice('session-x')).rejects.toThrow(
        'cannot invoice an uncosted session',
      );
    });

    it('creates a single line item from final cost when the session has no tariff', async () => {
      const now = new Date();
      setupDbResults(
        [
          {
            id: 'ses-no-tariff',
            driverId: 'd1',
            tariffId: null, // no tariff -> costBreakdown stays null
            energyDeliveredWh: '5000',
            startedAt: new Date(now.getTime() - 3600000),
            endedAt: now,
            finalCostCents: 700,
            currency: 'USD',
            status: 'completed',
            idleMinutes: '0',
            tariffPricePerKwh: null,
            tariffPricePerMinute: null,
            tariffPricePerSession: null,
            tariffIdleFeePricePerMinute: null,
            tariffTaxRate: null, // taxRate 0 -> subtotal == total branch
          },
        ],
        [], // segments: single tariff
        [{ id: 'inv-1', totalCents: 700, status: 'issued' }], // invoice insert
        [{ id: 'li-1', description: 'Charging session', totalCents: 700 }], // line items
      );

      const result = await createSessionInvoice('ses-no-tariff');

      expect(result.lineItems).toHaveLength(1);
      expect(result.lineItems[0]?.description).toBe('Charging session');
    });

    it('derives subtotal and tax from finalCostCents when no tariff but a tax rate exists', async () => {
      const now = new Date();
      setupDbResults(
        [
          {
            id: 'ses-tax',
            driverId: 'd1',
            tariffId: null,
            energyDeliveredWh: '5000',
            startedAt: new Date(now.getTime() - 3600000),
            endedAt: now,
            finalCostCents: 1080,
            currency: 'USD',
            status: 'completed',
            idleMinutes: '0',
            tariffPricePerKwh: null,
            tariffPricePerMinute: null,
            tariffPricePerSession: null,
            tariffIdleFeePricePerMinute: null,
            tariffTaxRate: '0.08', // taxRate>0 with null costBreakdown
          },
        ],
        [],
        [{ id: 'inv-2', totalCents: 1080, status: 'issued' }],
        [{ id: 'li-1', description: 'Charging session', totalCents: 1000 }],
      );

      const result = await createSessionInvoice('ses-tax');

      // 1080 / 1.08 = 1000 subtotal, 80 tax.
      expect(result.invoice.id).toBe('inv-2');
    });

    it('emits an idle-fee line item when the single-tariff breakdown has an idle fee', async () => {
      vi.mocked(calculateSessionCost).mockReturnValueOnce({
        energyCostCents: 500,
        timeCostCents: 0,
        sessionFeeCents: 0,
        idleFeeCents: 150,
        reservationHoldingFeeCents: 0,
        subtotalCents: 650,
        taxCents: 0,
        totalCents: 650,
        currency: 'USD',
      });
      const now = new Date();
      setupDbResults(
        [
          {
            id: 'ses-idle',
            driverId: 'd1',
            tariffId: 'trf-1',
            energyDeliveredWh: '5000',
            startedAt: new Date(now.getTime() - 3600000),
            endedAt: now,
            finalCostCents: 650,
            currency: 'USD',
            status: 'completed',
            idleMinutes: '10',
            tariffPricePerKwh: '0.25',
            tariffPricePerMinute: null,
            tariffPricePerSession: null,
            tariffIdleFeePricePerMinute: '0.15',
            tariffTaxRate: null,
          },
        ],
        [], // single tariff
        [{ id: 'inv-3', totalCents: 650, status: 'issued' }],
        [
          { id: 'li-1', description: 'Energy charge', totalCents: 500 },
          { id: 'li-2', description: 'Idle fee', totalCents: 150 },
        ],
      );

      const result = await createSessionInvoice('ses-idle');

      expect(result.lineItems.some((li) => li.description === 'Idle fee')).toBe(true);
    });

    it('builds multi-segment line items for split billing', async () => {
      const now = new Date();
      const seg1Start = new Date(now.getTime() - 3600000);
      const seg2Start = new Date(now.getTime() - 1800000);
      // Per-segment calculateSessionCost outputs (consumed in order).
      vi.mocked(calculateSessionCost)
        .mockReturnValueOnce({
          energyCostCents: 300,
          timeCostCents: 100,
          sessionFeeCents: 200,
          idleFeeCents: 50,
          reservationHoldingFeeCents: 0,
          subtotalCents: 650,
          taxCents: 0,
          totalCents: 650,
          currency: 'USD',
        })
        .mockReturnValueOnce({
          energyCostCents: 300,
          timeCostCents: 200,
          sessionFeeCents: 0,
          idleFeeCents: 0,
          reservationHoldingFeeCents: 0,
          subtotalCents: 500,
          taxCents: 0,
          totalCents: 500,
          currency: 'USD',
        });

      setupDbResults(
        // 1. session
        [
          {
            id: 'ses-split',
            driverId: 'd1',
            tariffId: 'trf-1',
            energyDeliveredWh: '12000',
            startedAt: seg1Start,
            endedAt: now,
            finalCostCents: 1188,
            currency: 'USD',
            status: 'completed',
            idleMinutes: '5',
            tariffPricePerKwh: '0.25',
            tariffPricePerMinute: '0.05',
            tariffPricePerSession: '2.00',
            tariffIdleFeePricePerMinute: '0.15',
            tariffTaxRate: '0.08',
          },
        ],
        // 2. segments (two -> split billing)
        [
          {
            startedAt: seg1Start,
            endedAt: seg2Start,
            energyWhStart: '0',
            energyWhEnd: '6000',
            idleMinutes: '3',
            tariffId: 'trf-1',
          },
          {
            startedAt: seg2Start,
            endedAt: now,
            energyWhStart: '6000',
            energyWhEnd: '12000',
            idleMinutes: '2',
            tariffId: 'trf-2',
          },
        ],
        // 3. tariffs IN query
        [
          {
            id: 'trf-1',
            pricePerKwh: '0.25',
            pricePerMinute: '0.05',
            pricePerSession: '2.00',
            idleFeePricePerMinute: '0.15',
            reservationFeePerMinute: null,
            taxRate: '0.08',
            currency: 'USD',
          },
          {
            id: 'trf-2',
            pricePerKwh: '0.30',
            pricePerMinute: '0.05',
            pricePerSession: null,
            idleFeePricePerMinute: '0.15',
            reservationFeePerMinute: null,
            taxRate: '0.08',
            currency: 'USD',
          },
        ],
        // 4. invoice insert
        [{ id: 'inv-split', totalCents: 1188, status: 'issued', taxCents: 88 }],
        // 5. line items insert
        [
          { id: 'li-1', description: 'Segment 1 energy charge', totalCents: 300 },
          { id: 'li-2', description: 'Segment 1 time charge', totalCents: 100 },
          { id: 'li-3', description: 'Session fee', totalCents: 200 },
          { id: 'li-4', description: 'Segment 1 idle fee', totalCents: 50 },
          { id: 'li-5', description: 'Segment 2 energy charge', totalCents: 300 },
          { id: 'li-6', description: 'Segment 2 time charge', totalCents: 200 },
          { id: 'li-7', description: 'Tax', totalCents: 88 },
        ],
      );

      const result = await createSessionInvoice('ses-split');

      expect(result.invoice.id).toBe('inv-split');
      expect(result.lineItems.length).toBeGreaterThan(4);
    });

    it('throws when the invoice insert returns no row', async () => {
      const now = new Date();
      setupDbResults(
        [
          {
            id: 'ses-fail',
            driverId: 'd1',
            tariffId: null,
            energyDeliveredWh: '1000',
            startedAt: new Date(now.getTime() - 3600000),
            endedAt: now,
            finalCostCents: 500,
            currency: 'USD',
            status: 'completed',
            idleMinutes: '0',
            tariffPricePerKwh: null,
            tariffPricePerMinute: null,
            tariffPricePerSession: null,
            tariffIdleFeePricePerMinute: null,
            tariffTaxRate: null,
          },
        ],
        [], // segments
        [], // invoice insert returns nothing
      );

      await expect(createSessionInvoice('ses-fail')).rejects.toThrow('Failed to create invoice');
    });
  });

  describe('createAggregatedInvoice', () => {
    it('creates invoice with tax breakdown from session tariff rates', async () => {
      const driverId = 'driver-789';
      const invoiceId = 'invoice-agg-1';
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');

      setupDbResults(
        // 1. sessions query (leftJoin -> where)
        [
          {
            id: 'session-1',
            finalCostCents: 540,
            currency: 'USD',
            startedAt: new Date('2026-01-05'),
            endedAt: new Date('2026-01-05T02:00:00Z'),
            energyDeliveredWh: '8000',
            tariffTaxRate: '0.08',
          },
          {
            id: 'session-2',
            finalCostCents: 324,
            currency: 'USD',
            startedAt: new Date('2026-01-15'),
            endedAt: new Date('2026-01-15T01:30:00Z'),
            energyDeliveredWh: '5000',
            tariffTaxRate: '0.08',
          },
        ],
        // 2. insert invoice returning (generateInvoiceNumber uses db.execute, not chained queries)
        [
          {
            id: invoiceId,
            invoiceNumber: `INV-${String(year)}${month}-0001`,
            driverId,
            status: 'issued',
            issuedAt: now,
            dueAt: new Date(now.getTime() + 30 * 86400000),
            currency: 'USD',
            subtotalCents: 800,
            taxCents: 64,
            totalCents: 864,
            metadata: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        // 3. insert line items returning
        [
          {
            id: 'li-1',
            invoiceId,
            sessionId: 'session-1',
            description: 'Charging session 2026-01-05 (8.00 kWh)',
            totalCents: 500,
            taxCents: 40,
          },
          {
            id: 'li-2',
            invoiceId,
            sessionId: 'session-2',
            description: 'Charging session 2026-01-15 (5.00 kWh)',
            totalCents: 300,
            taxCents: 24,
          },
        ],
      );

      const result = await createAggregatedInvoice(
        driverId,
        new Date('2026-01-01'),
        new Date('2026-01-31'),
      );

      expect(result.invoice.id).toBe(invoiceId);
      expect(result.invoice.status).toBe('issued');
      expect(result.lineItems).toHaveLength(2);
    });

    it('throws an AppError with INVOICE_NO_SESSIONS when no uninvoiced sessions found', async () => {
      setupDbResults([]);

      await expect(
        createAggregatedInvoice('driver-789', new Date('2026-01-01'), new Date('2026-01-31')),
      ).rejects.toMatchObject({
        message: 'No uninvoiced sessions found for this driver in the given date range',
        statusCode: 400,
        code: 'INVOICE_NO_SESSIONS',
      });
    });

    it('handles a zero-tax session and a null endedAt/null energy session', async () => {
      setupDbResults(
        [
          {
            id: 'session-1',
            finalCostCents: 500,
            currency: 'USD',
            startedAt: new Date('2026-01-05'),
            endedAt: null, // -> 'unknown' date
            energyDeliveredWh: null, // -> '0' kWh
            tariffTaxRate: null, // -> taxRate 0 branch
          },
        ],
        [{ id: 'inv-agg', totalCents: 500, status: 'issued' }],
        [{ id: 'li-1', description: 'Charging session unknown (0 kWh)', totalCents: 500 }],
      );

      const result = await createAggregatedInvoice(
        'd1',
        new Date('2026-01-01'),
        new Date('2026-01-31'),
      );

      expect(result.lineItems).toHaveLength(1);
      expect(result.lineItems[0]?.description).toContain('unknown');
    });

    it('throws when the aggregated invoice insert returns no row', async () => {
      setupDbResults(
        [
          {
            id: 'session-1',
            finalCostCents: 500,
            currency: 'USD',
            startedAt: new Date('2026-01-05'),
            endedAt: new Date('2026-01-05T02:00:00Z'),
            energyDeliveredWh: '5000',
            tariffTaxRate: '0.08',
          },
        ],
        [], // invoice insert -> nothing
      );

      await expect(
        createAggregatedInvoice('d1', new Date('2026-01-01'), new Date('2026-01-31')),
      ).rejects.toThrow('Failed to create invoice');
    });
  });

  describe('getInvoice', () => {
    it('returns the invoice with its line items when found', async () => {
      const invoice = { id: 'inv-1', invoiceNumber: 'INV-202601-0001', status: 'issued' };
      const lineItems = [{ id: 'li-1', invoiceId: 'inv-1', description: 'Energy charge' }];
      setupDbResults([invoice], lineItems);

      const result = await getInvoice('inv-1');

      expect(result).toEqual({ invoice, lineItems, driver: null });
    });

    it('includes the driver when the invoice has a driverId', async () => {
      const invoice = {
        id: 'inv-2',
        invoiceNumber: 'INV-202601-0002',
        status: 'issued',
        driverId: 'drv-1',
      };
      const lineItems = [{ id: 'li-2', invoiceId: 'inv-2', description: 'Energy charge' }];
      const driver = { id: 'drv-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@test.com' };
      setupDbResults([invoice], lineItems, [driver]);

      const result = await getInvoice('inv-2');

      expect(result).toEqual({ invoice, lineItems, driver });
    });

    it('returns null when the invoice does not exist', async () => {
      setupDbResults([]);

      const result = await getInvoice('missing');

      expect(result).toBeNull();
    });
  });

  describe('voidInvoice', () => {
    it('sets invoice status to void', async () => {
      const invoiceId = 'invoice-123';
      const now = new Date();

      setupDbResults(
        // 1. select invoice
        [
          {
            id: invoiceId,
            invoiceNumber: 'INV-202602-0001',
            driverId: 'driver-789',
            status: 'issued',
            issuedAt: now,
            dueAt: new Date(now.getTime() + 30 * 86400000),
            currency: 'USD',
            subtotalCents: 800,
            taxCents: 64,
            totalCents: 864,
            metadata: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        // 2. update returning
        [
          {
            id: invoiceId,
            invoiceNumber: 'INV-202602-0001',
            driverId: 'driver-789',
            status: 'void',
            issuedAt: now,
            dueAt: new Date(now.getTime() + 30 * 86400000),
            currency: 'USD',
            subtotalCents: 800,
            taxCents: 64,
            totalCents: 864,
            metadata: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      );

      const result = await voidInvoice(invoiceId);

      expect(result).not.toBeNull();
      expect(result?.status).toBe('void');
    });

    it('returns null when invoice not found', async () => {
      setupDbResults([]);

      const result = await voidInvoice('nonexistent');

      expect(result).toBeNull();
    });

    it('returns existing invoice when already void', async () => {
      const invoiceId = 'invoice-123';
      const now = new Date();

      setupDbResults([
        {
          id: invoiceId,
          invoiceNumber: 'INV-202602-0001',
          driverId: 'driver-789',
          status: 'void',
          issuedAt: now,
          dueAt: new Date(now.getTime() + 30 * 86400000),
          currency: 'USD',
          subtotalCents: 800,
          taxCents: 64,
          totalCents: 864,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const result = await voidInvoice(invoiceId);

      expect(result?.status).toBe('void');
    });
  });
});
