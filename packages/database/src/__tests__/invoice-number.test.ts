// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { getSystemTimezone } = vi.hoisted(() => ({ getSystemTimezone: vi.fn() }));
vi.mock('../lib/system-settings.js', () => ({ getSystemTimezone }));

const { allocateInvoiceNumber, invoiceNumberPrefix } = await import('../lib/invoice-number.js');

const dialect = new PgDialect();

function executor(rows: unknown[] = [{ value: '42' }]): {
  tx: { execute: (q: SQL) => Promise<unknown[]> };
  statements: string[];
  params: unknown[][];
} {
  const statements: string[] = [];
  const params: unknown[][] = [];
  return {
    statements,
    params,
    tx: {
      execute: (q: SQL) => {
        const query = dialect.sqlToQuery(q);
        statements.push(query.sql.replace(/\s+/g, ' '));
        params.push(query.params);
        return Promise.resolve(rows);
      },
    },
  };
}

beforeEach(() => {
  getSystemTimezone.mockReset();
  getSystemTimezone.mockResolvedValue('UTC');
});

describe('allocateInvoiceNumber', () => {
  it('formats INV-YYYYMM-NNNN from the invoice counter', async () => {
    const { tx } = executor();
    const result = await allocateInvoiceNumber(
      tx as never,
      'invoice',
      new Date('2026-06-15T12:00:00Z'),
    );
    expect(result).toBe('INV-202606-0042');
  });

  it('formats CN-YYYYMM-NNNN from the credit note counter', async () => {
    const { tx } = executor();
    const result = await allocateInvoiceNumber(
      tx as never,
      'credit_note',
      new Date('2026-06-15T12:00:00Z'),
    );
    expect(result).toBe('CN-202606-0042');
  });

  it('takes the month of the issue time in the system timezone', async () => {
    getSystemTimezone.mockResolvedValue('America/New_York');
    const { tx } = executor();
    // 23:30 on June 30 in New York is already July 1 in UTC.
    const result = await allocateInvoiceNumber(
      tx as never,
      'invoice',
      new Date('2026-07-01T03:30:00Z'),
    );
    expect(result).toBe('INV-202606-0042');
  });

  it.each(['invoice', 'credit_note'] as const)(
    'increments only the %s counter row, without a sequence',
    async (kind) => {
      const { tx, statements, params } = executor();
      await allocateInvoiceNumber(tx as never, kind, new Date('2026-06-15T12:00:00Z'));
      const text = statements.at(-1) ?? '';
      expect(text).toBe(
        'UPDATE invoice_number_counters SET value = value + 1 WHERE name = $1 RETURNING value',
      );
      expect(params.at(-1)).toEqual([kind]);
      expect(text).not.toMatch(/nextval|setval|_seq/);
    },
  );

  it('fails when the counter row is missing', async () => {
    const { tx } = executor([]);
    await expect(allocateInvoiceNumber(tx as never, 'credit_note', new Date())).rejects.toThrow(
      "Invoice number counter 'credit_note' is missing",
    );
  });
});

describe('invoiceNumberPrefix', () => {
  it('uses the month in the given timezone at a month boundary', () => {
    const issuedAt = new Date('2026-06-30T22:30:00Z');
    expect(invoiceNumberPrefix(issuedAt, 'UTC')).toBe('INV-202606-');
    expect(invoiceNumberPrefix(issuedAt, 'Europe/Berlin')).toBe('INV-202607-');
    expect(invoiceNumberPrefix(new Date('2027-01-01T02:00:00Z'), 'America/Los_Angeles')).toBe(
      'INV-202612-',
    );
  });

  it('uses CN for credit notes', () => {
    expect(invoiceNumberPrefix(new Date('2026-06-30T22:30:00Z'), 'UTC', 'credit_note')).toBe(
      'CN-202606-',
    );
  });

  it('falls back to UTC for an invalid timezone', () => {
    expect(invoiceNumberPrefix(new Date('2026-06-30T22:30:00Z'), 'Mars/Olympus')).toBe(
      'INV-202606-',
    );
  });
});

describe('invoice number of a period_end invoice date', () => {
  it('takes the prefix of the billed month from the noon date on the last day', async () => {
    // accountInvoiceDate dates an October invoice of a New York fleet at
    // 2026-10-31T16:00Z (noon EDT; DST ends on November 1).
    getSystemTimezone.mockResolvedValue('America/New_York');
    const { tx, statements } = executor([{ value: '7' }]);
    expect(
      await allocateInvoiceNumber(tx as never, 'invoice', new Date('2026-10-31T16:00:00Z')),
    ).toBe('INV-202610-0007');
    // The counter is shared, so the number stays unique and in issue order
    // although the date lies in the month before the run.
    expect(statements[0]).toContain('UPDATE invoice_number_counters SET value = value + 1');
    expect(invoiceNumberPrefix(new Date('2026-10-31T11:00:00Z'), 'Europe/Berlin')).toBe(
      'INV-202610-',
    );
  });
});
