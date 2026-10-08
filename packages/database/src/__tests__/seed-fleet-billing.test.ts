// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import argon2 from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

interface Call {
  text: string;
  values: unknown[];
}

const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; values: unknown[] }>,
  numbers: 0,
  rolledBack: 0,
  existingInvoices: new Set<string>(),
  // Invoice ids a concurrent seed inserts between the existence check and the insert.
  racedInvoices: new Set<string>(),
}));

const dialect = new PgDialect();

vi.mock('../lib/invoice-number.js', () => ({
  allocateInvoiceNumber: vi.fn((_tx: unknown, kind: string) => {
    h.numbers += 1;
    return Promise.resolve(`${kind === 'invoice' ? 'INV' : 'CN'}-202610-${String(h.numbers)}`);
  }),
}));

vi.mock('../config.js', () => ({
  db: {
    transaction: async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const tx = {
        execute: (q: SQL) => {
          const { sql: text, params } = dialect.sqlToQuery(q);
          h.calls.push({ text: text.replace(/\s+/g, ' '), values: params });
          const id = params[0] as string;
          return Promise.resolve(h.racedInvoices.has(id) ? [] : [{ id }]);
        },
      };
      try {
        return await work(tx);
      } catch (err) {
        h.rolledBack += 1;
        throw err;
      }
    },
  },
}));

const { FLEET_BILLING_DEMO, fleetBillingDemoSessions, seedFleetBillingDemo } =
  await import('../seed-fleet-billing.js');
const { allocateInvoiceNumber } = await import('../lib/invoice-number.js');

const NOW = new Date('2026-10-08T12:00:00Z');

beforeEach(() => {
  h.calls = [];
  h.numbers = 0;
  h.rolledBack = 0;
  h.existingInvoices = new Set();
  h.racedInvoices = new Set();
  vi.mocked(allocateInvoiceNumber).mockClear();
});

function fakeSql(): { sql: unknown; calls: Call[] } {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ');
      h.calls.push({ text, values });
      if (text.includes('FROM charging_stations')) {
        return Promise.resolve([{ station_id: 'CS-0001', site_name: 'Depot' }]);
      }
      if (text.includes('SELECT 1 FROM invoices WHERE id')) {
        return Promise.resolve(
          h.existingInvoices.has(values[0] as string) ? [{ '?column?': 1 }] : [],
        );
      }
      if (text.includes('RETURNING id')) return Promise.resolve([{ id: values[0] }]);
      return Promise.resolve([]);
    },
    { json: (value: unknown) => value },
  );
  return { sql, calls: h.calls };
}

const seedInput = {
  stationId: 'sta_000000000001',
  evseId: null,
  currency: 'USD',
  now: NOW,
};

describe('fleetBillingDemoSessions', () => {
  // Fleet invoices bill months of the system timezone: every session is in its
  // month in all timezones, UTC-12 (month starts 12:00 UTC) to UTC+14 (month
  // starts 10:00 UTC the day before).
  it('places unbilled sessions in this month before now and bills the rest on last month', () => {
    const sessions = fleetBillingDemoSessions(NOW);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(sessions.length);
    expect(sessions.every((s) => /^ses_demoacct\d{4}$/.test(s.id))).toBe(true);
    const unbilled = sessions.filter((s) => s.invoiceId == null);
    expect(unbilled).toHaveLength(4);
    for (const s of unbilled) {
      expect(s.startedAt.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 1, 12));
      expect(s.endedAt.getTime()).toBeLessThan(NOW.getTime());
    }
    const billed = sessions.filter((s) => s.invoiceId === FLEET_BILLING_DEMO.invoiceId);
    expect(billed).toHaveLength(5);
    expect(billed.every((s) => s.endedAt.getTime() < Date.UTC(2026, 8, 30, 10))).toBe(true);
  });
});

describe('seedFleetBillingDemo', () => {
  it('writes header totals equal to the line sums and negates the credit note', async () => {
    const { sql } = fakeSql();
    const inserted = await seedFleetBillingDemo(sql as never, seedInput);
    expect(inserted).toBe(9);

    const calls = h.calls;
    const headers = calls.filter((c) => c.text.includes('INSERT INTO invoices ('));
    expect(headers.map((c) => c.values[0])).toEqual([
      FLEET_BILLING_DEMO.creditedInvoiceId,
      FLEET_BILLING_DEMO.creditNoteId,
      FLEET_BILLING_DEMO.invoiceId,
    ]);
    const lines = calls.filter((c) => c.text.startsWith(' INSERT INTO invoice_line_items'));
    for (const header of headers) {
      const own = lines.filter((l) => l.values[0] === header.values[0]);
      const net = own.reduce((sum, l) => sum + (l.values[5] as number), 0);
      const tax = own.reduce((sum, l) => sum + (l.values[6] as number), 0);
      // subtotal, tax and total follow the currency in the VALUES list.
      expect(header.values.slice(9, 12)).toEqual([net, tax, net + tax]);
      expect(own[0]?.values[8]).toMatchObject({
        kind: 'session',
        driverName: expect.any(String),
        stationName: 'Depot CS-0001',
      });
    }
    const [credited, creditNote] = headers;
    expect(creditNote?.values[11]).toBe(-(credited?.values[11] as number));
  });

  it('gives each member the demo driver password only where none is set', async () => {
    const { sql } = fakeSql();
    await seedFleetBillingDemo(sql as never, seedInput);

    const updates = h.calls.filter((c) => c.text.includes('UPDATE drivers SET password_hash'));
    expect(updates.map((c) => c.values[1])).toEqual([
      FLEET_BILLING_DEMO.accountDriverId,
      FLEET_BILLING_DEMO.secondDriverId,
      FLEET_BILLING_DEMO.optedOutDriverId,
    ]);
    for (const update of updates) {
      expect(update.text).toContain('password_hash IS NULL');
      expect(await argon2.verify(update.values[0] as string, 'driver123')).toBe(true);
    }
  });

  it('numbers the invoices and the credit note from the gap-free counter', async () => {
    const { sql } = fakeSql();
    await seedFleetBillingDemo(sql as never, seedInput);
    const headers = h.calls.filter((c) => c.text.includes('INSERT INTO invoices ('));
    expect(headers.map((c) => c.values[1])).toEqual([
      'INV-202610-1',
      'CN-202610-2',
      'INV-202610-3',
    ]);
    expect(vi.mocked(allocateInvoiceNumber).mock.calls.map((c) => c[1])).toEqual([
      'invoice',
      'credit_note',
      'invoice',
    ]);
  });

  it('allocates no number for an invoice a previous run inserted', async () => {
    h.existingInvoices = new Set([
      FLEET_BILLING_DEMO.creditedInvoiceId,
      FLEET_BILLING_DEMO.creditNoteId,
      FLEET_BILLING_DEMO.invoiceId,
    ]);
    const { sql } = fakeSql();
    await seedFleetBillingDemo(sql as never, seedInput);
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.text.includes('INSERT INTO invoices ('))).toBe(false);
  });

  it('rolls the number back when a concurrent seed inserted the invoice first', async () => {
    h.racedInvoices = new Set([FLEET_BILLING_DEMO.invoiceId]);
    const { sql } = fakeSql();
    await seedFleetBillingDemo(sql as never, seedInput);
    expect(h.rolledBack).toBe(1);
  });
});
