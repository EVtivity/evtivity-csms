// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => {
  const state = {
    timeZone: 'UTC',
    currency: 'EUR',
    fleet: null as Record<string, unknown> | null,
    candidates: [] as Array<Record<string, unknown>>,
    // The live invoice of the period each lookup returns, in order (then the last).
    periodInvoices: [] as Array<Record<string, unknown> | null>,
    statements: [] as string[],
    params: [] as unknown[][],
  };
  const table = (name: string) => {
    const columns: Record<string, unknown> = { __table: name };
    return new Proxy(columns, {
      get: (target, prop) => (prop in target ? target[prop as string] : `${name}.${String(prop)}`),
    });
  };
  return { state, table };
});

const dialect = new PgDialect();

function render(query: SQL): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return { text: text.replace(/\s+/g, ' '), params };
}

async function execute(query: SQL): Promise<unknown[]> {
  const { text, params } = render(query);
  h.state.statements.push(text);
  h.state.params.push(params);
  if (text.includes('FROM fleets WHERE id')) return h.state.fleet == null ? [] : [h.state.fleet];
  if (text.includes('FROM charging_sessions cs')) return h.state.candidates;
  if (text.includes('FROM invoices WHERE fleet_id')) {
    const next =
      h.state.periodInvoices.length > 1
        ? h.state.periodInvoices.shift()
        : h.state.periodInvoices[0];
    return next == null ? [] : [next];
  }
  return [];
}

vi.mock('@evtivity/database', () => ({
  db: {
    execute: vi.fn((q: SQL) => execute(q)),
    transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) =>
      work({ execute: (q: SQL) => execute(q) }),
    ),
  },
  invoices: h.table('invoices'),
  invoiceLineItems: h.table('invoiceLineItems'),
  chargingSessions: h.table('chargingSessions'),
  drivers: h.table('drivers'),
  fleets: h.table('fleets'),
  paymentRecords: h.table('paymentRecords'),
  getCompanyCurrency: vi.fn(() => Promise.resolve(h.state.currency)),
  getSystemTimezone: vi.fn(() => Promise.resolve(h.state.timeZone)),
  getInvoicePaymentTermsDays: vi.fn(() => Promise.resolve(30)),
  PG_UNIQUE_VIOLATION: '23505',
  pgErrorCode: (err: unknown) => (err as { code?: string }).code,
  pgConstraintName: (err: unknown) => (err as { constraint_name?: string }).constraint_name,
}));

vi.mock('@evtivity/payments', () => ({
  claimFeeRecordsForInvoice: vi.fn(() => Promise.resolve([])),
  releaseInvoiceFeeRecords: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../invoice.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../invoice.service.js')>();
  return { ...original, insertInvoiceInTransaction: vi.fn() };
});

import { insertInvoiceInTransaction } from '../invoice.service.js';
import type { InsertInvoiceInput } from '../invoice.service.js';
import {
  billToFromFleet,
  createFleetInvoice,
  fleetInvoicePeriod,
  fleetSessionLines,
  planFleetInvoice,
  previewFleetInvoice,
  previousPeriod,
  zonedMidnight,
} from '../fleet-invoice.service.js';
import type { FleetSessionCandidate } from '../fleet-invoice.service.js';
import { calculateSessionCost, toSessionCostBreakdown, taxTotals } from '@evtivity/lib';

function candidate(overrides: Partial<FleetSessionCandidate> = {}): FleetSessionCandidate {
  return {
    id: 'ses_1',
    driverId: 'drv_a',
    driverName: 'Anna Berg',
    stationName: 'CS-01',
    siteName: 'Depot',
    endedAt: new Date('2026-09-10T08:00:00Z'),
    energyDeliveredWh: '12000',
    finalCostCents: 1190,
    currency: 'EUR',
    tariffTaxRate: '0.19',
    costBreakdown: null,
    ...overrides,
  };
}

function candidateRow(c: FleetSessionCandidate): Record<string, unknown> {
  const [first = '', last = ''] = c.driverName.split(' ');
  return {
    id: c.id,
    driver_id: c.driverId,
    first_name: first,
    last_name: last,
    station_name: c.stationName,
    site_name: c.siteName,
    ended_at: c.endedAt,
    energy_delivered_wh: c.energyDeliveredWh,
    final_cost_cents: c.finalCostCents,
    currency: c.currency,
    tariff_tax_rate: c.tariffTaxRate,
    cost_breakdown: c.costBreakdown,
  };
}

const fleetRow = {
  id: 'flt_1',
  name: 'Acme Logistics',
  billing_legal_name: 'Acme Logistics GmbH',
  billing_street: 'Hafenstr. 1',
  billing_city: 'Hamburg',
  billing_state: null,
  billing_zip: '20457',
  billing_country: 'Germany',
  billing_tax_id: 'DE123456789',
  invoice_language: 'de',
  payment_terms_days: 14,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.timeZone = 'UTC';
  h.state.currency = 'EUR';
  h.state.fleet = { ...fleetRow };
  h.state.candidates = [];
  h.state.periodInvoices = [null];
  h.state.statements = [];
  h.state.params = [];
  vi.mocked(insertInvoiceInTransaction).mockImplementation((_tx, input: InsertInvoiceInput) =>
    Promise.resolve({
      invoice: { id: 'inv_9', invoiceNumber: 'INV-202610-0009', totalCents: input.chargedCents },
      lineItems: [],
    } as never),
  );
});

describe('fleetInvoicePeriod', () => {
  it('bounds a month at midnight in the system timezone, across a DST change', () => {
    const bounds = fleetInvoicePeriod('2026-10', 'Europe/Berlin');
    expect(bounds.periodStart).toBe('2026-10-01');
    expect(bounds.periodEnd).toBe('2026-10-31');
    expect(bounds.startsAt.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    // CET again after the last Sunday of October.
    expect(bounds.endsAt.toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });

  it('rolls December into January and knows leap years', () => {
    expect(fleetInvoicePeriod('2026-12', 'UTC').endsAt.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(fleetInvoicePeriod('2028-02', 'UTC').periodEnd).toBe('2028-02-29');
  });

  it('refuses a malformed period', () => {
    expect(() => fleetInvoicePeriod('2026-13', 'UTC')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }),
    );
    expect(() => fleetInvoicePeriod('2026-1', 'UTC')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('computes in UTC for an invalid timezone', () => {
    expect(fleetInvoicePeriod('2026-03', 'Not/AZone').startsAt.toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });
});

describe('zonedMidnight and previousPeriod', () => {
  it('finds local midnight west of UTC', () => {
    expect(zonedMidnight(2026, 3, 8, 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('takes the month before the current one in the timezone', () => {
    expect(previousPeriod(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe('2025-12');
    // Already November in Berlin, still October in UTC.
    expect(previousPeriod(new Date('2026-10-31T23:30:00Z'), 'Europe/Berlin')).toBe('2026-10');
  });
});

describe('billToFromFleet', () => {
  it('uses the legal name, else the fleet name', () => {
    const fleet = {
      id: 'flt_1',
      name: 'Acme',
      billingLegalName: '  ',
      billingStreet: null,
      billingCity: null,
      billingState: null,
      billingZip: null,
      billingCountry: null,
      billingTaxId: 'DE1',
      invoiceLanguage: 'en',
      paymentTermsDays: null,
    };
    expect(billToFromFleet(fleet)).toMatchObject({ name: 'Acme', taxId: 'DE1' });
    expect(billToFromFleet({ ...fleet, billingLegalName: 'Acme GmbH' }).name).toBe('Acme GmbH');
  });
});

describe('planFleetInvoice', () => {
  it('leaves zero-cost, uncosted and other-currency sessions off and lists them', () => {
    const plan = planFleetInvoice(
      [
        candidate({ id: 'ses_paid' }),
        candidate({ id: 'ses_zero', finalCostCents: 0 }),
        candidate({ id: 'ses_none', finalCostCents: null }),
        candidate({ id: 'ses_usd', currency: 'usd' }),
      ],
      'EUR',
      'UTC',
    );
    expect(plan.sessions.map((s) => s.id)).toEqual(['ses_paid']);
    expect(plan.excluded.map((e) => [e.sessionId, e.reason, e.currency])).toEqual([
      ['ses_zero', 'zero_cost', 'EUR'],
      ['ses_none', 'uncosted', 'EUR'],
      ['ses_usd', 'other_currency', 'USD'],
    ]);
    expect(plan.totalCents).toBe(1190);
  });

  it('groups by driver name with subtotals and keeps each session tax snapshot', () => {
    const plan = planFleetInvoice(
      [
        candidate({ id: 'ses_z1', driverId: 'drv_z', driverName: 'Zoe Ng', finalCostCents: 1070 }),
        candidate({
          id: 'ses_a2',
          endedAt: new Date('2026-09-20T08:00:00Z'),
          tariffTaxRate: '0.07',
          finalCostCents: 1070,
        }),
        candidate({ id: 'ses_a1', endedAt: new Date('2026-09-05T08:00:00Z') }),
      ],
      'EUR',
      'UTC',
    );
    expect(plan.sessions.map((s) => s.id)).toEqual(['ses_a1', 'ses_a2', 'ses_z1']);
    expect(plan.drivers).toEqual([
      expect.objectContaining({ driverId: 'drv_a', sessionCount: 2, totalCents: 2260 }),
      expect.objectContaining({ driverId: 'drv_z', sessionCount: 1, totalCents: 1070 }),
    ]);
    expect(plan.lines.map((l) => [l.sessionId, l.taxRate])).toEqual([
      ['ses_a1', 0.19],
      ['ses_a2', 0.07],
      ['ses_z1', 0.19],
    ]);
    expect(plan.lines[0]?.metadata).toMatchObject({
      kind: 'session',
      sessionDate: '2026-09-05',
      energyWh: 12000,
      driverId: 'drv_a',
      driverName: 'Anna Berg',
      stationName: 'Depot CS-01',
    });
    expect(plan.totalCents).toBe(1190 + 1070 + 1070);
    expect(plan.energyWh).toBe(36000);
  });

  it('dates a session in the system timezone', () => {
    const plan = planFleetInvoice(
      [candidate({ endedAt: new Date('2026-09-30T23:30:00Z') })],
      'EUR',
      'Europe/Berlin',
    );
    expect(plan.lines[0]?.metadata.sessionDate).toBe('2026-10-01');
  });
});

describe('createFleetInvoice', () => {
  const now = new Date('2026-10-08T10:00:00Z');

  it('issues the invoice of the fleet and period with the bill-to snapshot and terms', async () => {
    h.state.candidates = [candidateRow(candidate()), candidateRow(candidate({ id: 'ses_2' }))];

    const result = await createFleetInvoice('flt_1', '2026-09', now);

    expect(result.invoice.id).toBe('inv_9');
    const input = vi.mocked(insertInvoiceInTransaction).mock.calls[0]?.[1];
    expect(input).toMatchObject({
      driverId: null,
      currency: 'EUR',
      status: 'issued',
      chargedCents: 2380,
      paymentTermsDays: 14,
      fleet: {
        fleetId: 'flt_1',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        language: 'de',
        billTo: {
          name: 'Acme Logistics GmbH',
          street: 'Hafenstr. 1',
          city: 'Hamburg',
          zip: '20457',
          country: 'Germany',
          taxId: 'DE123456789',
        },
      },
    });
    expect(input?.lines).toHaveLength(2);
  });

  it('selects only unbilled account sessions of the fleet without a payment record, ended before the period end', async () => {
    h.state.candidates = [candidateRow(candidate())];
    await createFleetInvoice('flt_1', '2026-09', now);

    const index = h.state.statements.findIndex((s) => s.includes('FROM charging_sessions cs'));
    const text = h.state.statements[index] ?? '';
    expect(text).toContain("cs.billing_mode = 'account'");
    expect(text).toContain('cs.billing_fleet_id = $1');
    expect(text).toContain("cs.status = 'completed'");
    expect(text).toContain('cs.invoice_id IS NULL');
    expect(text).toContain(
      'NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)',
    );
    // The invoice_id claim is the only guard: no line-item lookup.
    expect(text).not.toContain('invoice_line_items');
    // A session that ends after the month is not selected: it rolls into the next invoice.
    expect(text).toContain('cs.ended_at < $2::timestamptz');
    expect(h.state.params[index]).toEqual(['flt_1', '2026-10-01T00:00:00.000Z']);
    // On demand, earlier unbilled sessions are billed too: no lower bound.
    expect(text).not.toContain('cs.ended_at >=');
  });

  it('bills only the sessions ended in the month for the scheduled run (periodOnly)', async () => {
    h.state.candidates = [candidateRow(candidate())];
    await createFleetInvoice('flt_1', '2026-09', now, { periodOnly: true });

    const index = h.state.statements.findIndex((s) => s.includes('FROM charging_sessions cs'));
    const text = h.state.statements[index] ?? '';
    expect(text).toContain('cs.ended_at < $2::timestamptz');
    expect(text).toContain('cs.ended_at >= $3::timestamptz');
    expect(h.state.params[index]).toEqual([
      'flt_1',
      '2026-10-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ]);
  });

  it('claims only sessions still billed on account to the fleet', async () => {
    h.state.candidates = [candidateRow(candidate())];
    await createFleetInvoice('flt_1', '2026-09', now);
    const guard = vi.mocked(insertInvoiceInTransaction).mock.calls[0]?.[1].sessionClaimGuard;
    const { text, params } = render(guard as SQL);
    expect(text).toContain("= 'account'");
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM payment_records fpr');
    expect(params).toContain('flt_1');
  });

  it('locks the fleet and refuses a live invoice of the period inside the transaction', async () => {
    h.state.candidates = [candidateRow(candidate())];
    // The check before the transaction finds none; a concurrent generation
    // issued one before the lock was taken.
    h.state.periodInvoices = [
      null,
      { id: 'inv_1', invoice_number: 'INV-202610-0001', status: 'issued' },
    ];
    await expect(createFleetInvoice('flt_1', '2026-09', now)).rejects.toMatchObject({
      code: 'FLEET_INVOICE_PERIOD_EXISTS',
      statusCode: 409,
    });
    expect(h.state.statements.some((s) => /FROM fleets WHERE id = \$1 FOR UPDATE/.test(s))).toBe(
      true,
    );
    expect(insertInvoiceInTransaction).not.toHaveBeenCalled();
  });

  it('reads and locks the sessions under the fleet lock before the invoice is numbered', async () => {
    h.state.candidates = [candidateRow(candidate())];
    let statementsAtInsert: string[] = [];
    vi.mocked(insertInvoiceInTransaction).mockImplementationOnce((_tx, input) => {
      statementsAtInsert = [...h.state.statements];
      return Promise.resolve({
        invoice: { id: 'inv_9', totalCents: input.chargedCents },
        lineItems: [],
      } as never);
    });
    await createFleetInvoice('flt_1', '2026-09', now);

    const lockIndex = statementsAtInsert.findIndex((s) =>
      /FROM fleets WHERE id = \$1 FOR UPDATE/.test(s),
    );
    const sessionsIndex = statementsAtInsert.findIndex((s) =>
      s.includes('FROM charging_sessions cs'),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(sessionsIndex).toBeGreaterThan(lockIndex);
    expect(statementsAtInsert[sessionsIndex]).toContain('FOR UPDATE OF cs');
  });

  it('refuses with nothing to bill when the locked read finds the sessions billed meanwhile, without numbering', async () => {
    // A concurrent generation billed every candidate before this one got the lock.
    h.state.candidates = [];
    await expect(createFleetInvoice('flt_1', '2026-09', now)).rejects.toMatchObject({
      code: 'FLEET_INVOICE_NOTHING_TO_BILL',
      statusCode: 409,
    });
    expect(insertInvoiceInTransaction).not.toHaveBeenCalled();
  });

  it('refuses a period that already has a live invoice', async () => {
    h.state.periodInvoices = [{ id: 'inv_1', invoice_number: 'INV-202610-0001', status: 'paid' }];
    h.state.candidates = [candidateRow(candidate())];
    await expect(createFleetInvoice('flt_1', '2026-09', now)).rejects.toMatchObject({
      code: 'FLEET_INVOICE_PERIOD_EXISTS',
      statusCode: 409,
    });
    expect(insertInvoiceInTransaction).not.toHaveBeenCalled();
  });

  it('answers the unique index violation of a concurrent generation with 409', async () => {
    h.state.candidates = [candidateRow(candidate())];
    h.state.periodInvoices = [
      null,
      null,
      { id: 'inv_2', invoice_number: 'INV-202610-0002', status: 'issued' },
    ];
    vi.mocked(insertInvoiceInTransaction).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint_name: 'uq_invoices_fleet_period',
      }),
    );
    await expect(createFleetInvoice('flt_1', '2026-09', now)).rejects.toMatchObject({
      code: 'FLEET_INVOICE_PERIOD_EXISTS',
    });
  });

  it('turns a session billed meanwhile into INVOICE_CREATION_FAILED', async () => {
    h.state.candidates = [candidateRow(candidate())];
    vi.mocked(insertInvoiceInTransaction).mockRejectedValueOnce(
      new Error('Session is already invoiced'),
    );
    await expect(createFleetInvoice('flt_1', '2026-09', now)).rejects.toMatchObject({
      code: 'INVOICE_CREATION_FAILED',
      statusCode: 400,
    });
  });

  it('refuses when nothing has a cost in the company currency', async () => {
    h.state.candidates = [
      candidateRow(candidate({ finalCostCents: 0 })),
      candidateRow(candidate({ id: 'ses_usd', currency: 'USD' })),
    ];
    await expect(createFleetInvoice('flt_1', '2026-09', now)).rejects.toMatchObject({
      code: 'FLEET_INVOICE_NOTHING_TO_BILL',
      statusCode: 409,
    });
  });

  it('refuses a future period and an unknown fleet', async () => {
    await expect(createFleetInvoice('flt_1', '2026-11', now)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    h.state.fleet = null;
    await expect(createFleetInvoice('flt_x', '2026-09', now)).rejects.toMatchObject({
      code: 'FLEET_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('falls back to English for an unknown fleet invoice language', async () => {
    h.state.fleet = { ...fleetRow, invoice_language: 'fr', payment_terms_days: null };
    h.state.candidates = [candidateRow(candidate())];
    await createFleetInvoice('flt_1', '2026-09', now);
    const input = vi.mocked(insertInvoiceInTransaction).mock.calls[0]?.[1];
    expect(input?.fleet?.language).toBe('en');
    expect(input?.paymentTermsDays).toBeNull();
  });
});

describe('previewFleetInvoice', () => {
  it('totals per driver, lists excluded sessions and the live invoice of the period', async () => {
    h.state.candidates = [
      candidateRow(candidate()),
      candidateRow(candidate({ id: 'ses_zero', finalCostCents: 0 })),
    ];
    h.state.periodInvoices = [{ id: 'inv_1', invoice_number: 'INV-202610-0001', status: 'issued' }];
    const preview = await previewFleetInvoice('flt_1', '2026-09');
    expect(preview).toMatchObject({
      period: '2026-09',
      currency: 'EUR',
      sessionCount: 1,
      totalCents: 1190,
      excludedCount: 1,
      existingInvoice: { id: 'inv_1', invoiceNumber: 'INV-202610-0001', status: 'issued' },
    });
    expect(preview.drivers).toHaveLength(1);
    expect(preview.excluded[0]).toMatchObject({ sessionId: 'ses_zero', reason: 'zero_cost' });
  });
});

describe('fleetSessionLines', () => {
  const tariff = {
    pricePerKwh: '0.25',
    pricePerMinute: '0',
    pricePerSession: '1.00',
    idleFeePricePerMinute: '0.10',
    reservationFeePerMinute: null,
    taxRate: '0.10',
  };
  const session = (idleMinutes: number, basis: 'net' | 'gross' = 'net') => {
    const breakdown = toSessionCostBreakdown(
      calculateSessionCost(tariff, 10000, 90, idleMinutes, 30, 0, basis),
    );
    return {
      id: 'sess-1',
      invoiceId: null,
      driverId: 'drv-1',
      energyDeliveredWh: '10000',
      endedAt: new Date('2026-09-15T10:00:00Z'),
      finalCostCents: breakdown.grossCents,
      tariffTaxRate: '0.10',
      costBreakdown: breakdown,
    };
  };

  it('shows the idle fee as its own line with the billed minutes, totals unchanged', () => {
    // 55 idle minutes, grace 30: 25 billed = 2.50 net. Session 1.00 + 2.50.
    const lines = fleetSessionLines(session(55));
    expect(lines.map((l) => [l.metadata.kind, l.netCents, l.taxCents])).toEqual([
      ['session', 350, 35],
      ['idleFee', 250, 25],
    ]);
    expect(lines[1]?.metadata.idleMinutes).toBe(25);
    expect(lines[1]?.description).toBe('Idle fee, 25 min');
    expect(taxTotals(lines)).toMatchObject({ netCents: 600, taxCents: 60, grossCents: 660 });
  });

  it('keeps net plus tax of the lines equal to the gross on the gross basis', () => {
    const s = session(55, 'gross');
    const lines = fleetSessionLines(s);
    expect(lines.map((l) => l.metadata.kind)).toEqual(['session', 'idleFee']);
    expect(taxTotals(lines).grossCents).toBe(s.finalCostCents);
  });

  it('bills one session line when no idle fee was charged', () => {
    const lines = fleetSessionLines(session(20));
    expect(lines.map((l) => l.metadata.kind)).toEqual(['session']);
  });
});
