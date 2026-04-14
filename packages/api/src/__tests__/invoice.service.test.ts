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
  between: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
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
  voidInvoice,
} from '../services/invoice.service.js';

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

    it('throws when no uninvoiced sessions found', async () => {
      setupDbResults([]);

      await expect(
        createAggregatedInvoice('driver-789', new Date('2026-01-01'), new Date('2026-01-31')),
      ).rejects.toThrow('No uninvoiced sessions found');
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
