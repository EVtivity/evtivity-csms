// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    // The invoice the locked select returns.
    invoice: null as Record<string, unknown> | null,
    lines: [] as Array<Record<string, unknown>>,
    inserted: {} as Record<string, Array<Record<string, unknown>>>,
    updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
    // Rows the status update of the invoice returns (empty: it changed meanwhile).
    statusUpdate: null as Array<Record<string, unknown>> | null,
    releasedSessions: [] as string[],
    lockedForUpdate: false,
  };

  // Column references read as '<table>.<column>' strings.
  const table = (name: string) => {
    const columns: Record<string, unknown> = { __table: name };
    return new Proxy(columns, {
      get: (target, prop) => (prop in target ? target[prop as string] : `${name}.${String(prop)}`),
    });
  };

  function selectChain() {
    let tableName = '';
    const chain: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy']) chain[m] = vi.fn(() => chain);
    chain['for'] = vi.fn(() => {
      state.lockedForUpdate = true;
      return chain;
    });
    chain['from'] = vi.fn((t: { __table: string }) => {
      tableName = t.__table;
      return chain;
    });
    chain['then'] = (onFulfilled?: (v: unknown) => unknown) => {
      const rows =
        tableName === 'invoices' ? (state.invoice == null ? [] : [state.invoice]) : state.lines;
      return Promise.resolve(rows).then(onFulfilled);
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
    chain['returning'] = vi.fn(() =>
      Promise.resolve(
        rows.map((r, i) => (t.__table === 'invoices' ? { id: 'cn_1', ...r } : { id: i + 1, ...r })),
      ),
    );
    return chain;
  }

  function updateChain(t: { __table: string }) {
    let values: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    chain['set'] = vi.fn((v: Record<string, unknown>) => {
      values = v;
      state.updates.push({ table: t.__table, set: v });
      return chain;
    });
    chain['where'] = vi.fn(() => chain);
    chain['returning'] = vi.fn(() => {
      if (t.__table === 'chargingSessions') {
        return Promise.resolve(state.releasedSessions.map((id) => ({ id })));
      }
      if (state.statusUpdate != null) return Promise.resolve(state.statusUpdate);
      // The committed row: a later locked select of the invoice reads it.
      state.invoice = { ...state.invoice, ...values };
      return Promise.resolve([state.invoice]);
    });
    return chain;
  }

  return { state, table, selectChain, insertChain, updateChain };
});

vi.mock('@evtivity/database', () => {
  const db = {
    select: vi.fn(() => h.selectChain()),
    insert: vi.fn((t: { __table: string }) => h.insertChain(t)),
    update: vi.fn((t: { __table: string }) => h.updateChain(t)),
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return {
    db,
    invoices: h.table('invoices'),
    invoiceLineItems: h.table('invoiceLineItems'),
    chargingSessions: h.table('chargingSessions'),
    allocateInvoiceNumber: vi.fn(() => Promise.resolve('CN-202606-0001')),
  };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('../invoice.service.js', async () => {
  const { AppError } = await import('@evtivity/lib');
  return {
    creditNoteError: () => new AppError('This is a credit note', 409, 'INVOICE_IS_CREDIT_NOTE'),
  };
});

import { db, allocateInvoiceNumber } from '@evtivity/database';
import { creditInvoice } from '../credit-note.service.js';

const ISSUED = new Date('2026-06-01T10:00:00Z');

function invoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-202606-0042',
    kind: 'invoice',
    driverId: 'drv_1',
    status: 'issued',
    issuedAt: ISSUED,
    currency: 'EUR',
    subtotalCents: 400,
    taxCents: 76,
    totalCents: 476,
    ...overrides,
  };
}

const LINES = [
  {
    id: 1,
    invoiceId: 'inv_1',
    sessionId: 'ses_1',
    paymentRecordId: null,
    description: 'Energy charge',
    quantity: '1',
    unitPriceCents: 300,
    totalCents: 300,
    taxCents: 57,
    taxRate: '0.19',
    metadata: { kind: 'energy' },
  },
  {
    id: 2,
    invoiceId: 'inv_1',
    sessionId: null,
    paymentRecordId: 9,
    description: 'Reservation no-show fee',
    quantity: '1',
    unitPriceCents: 100,
    totalCents: 100,
    taxCents: 19,
    taxRate: '0.19',
    metadata: { kind: 'noShowFee' },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.state.invoice = invoice();
  h.state.lines = LINES;
  h.state.inserted = {};
  h.state.updates = [];
  h.state.statusUpdate = null;
  h.state.releasedSessions = ['ses_1'];
  h.state.lockedForUpdate = false;
});

describe('creditInvoice', () => {
  it('issues a credit note that mirrors every line negated and references the invoice', async () => {
    const result = await creditInvoice('inv_1', 'Wrong tariff');

    const [note] = h.state.inserted['invoices'] ?? [];
    expect(note).toMatchObject({
      invoiceNumber: 'CN-202606-0001',
      kind: 'credit_note',
      creditedInvoiceId: 'inv_1',
      creditReason: 'Wrong tariff',
      driverId: 'drv_1',
      status: 'issued',
      dueAt: null,
      paidAt: null,
      currency: 'EUR',
      subtotalCents: -400,
      taxCents: -76,
      totalCents: -476,
    });
    expect(h.state.inserted['invoiceLineItems']).toEqual([
      expect.objectContaining({
        invoiceId: 'cn_1',
        sessionId: 'ses_1',
        paymentRecordId: null,
        unitPriceCents: -300,
        totalCents: -300,
        taxCents: -57,
        taxRate: '0.19',
        metadata: { kind: 'energy' },
      }),
      expect.objectContaining({
        invoiceId: 'cn_1',
        paymentRecordId: 9,
        unitPriceCents: -100,
        totalCents: -100,
        taxCents: -19,
      }),
    ]);
    expect(result?.creditNote.invoice.id).toBe('cn_1');
    expect(vi.mocked(allocateInvoiceNumber)).toHaveBeenCalledWith(
      expect.anything(),
      'credit_note',
      expect.any(Date),
    );
  });

  it('carries the fleet, period, bill-to block and language of a fleet invoice', async () => {
    const billTo = { name: 'Acme Logistics GmbH', taxId: 'DE1' };
    h.state.invoice = invoice({
      driverId: null,
      fleetId: 'flt_1',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      billTo,
      language: 'de',
    });
    const result = await creditInvoice('inv_1', 'Wrong tariff');

    const [note] = h.state.inserted['invoices'] ?? [];
    expect(note).toMatchObject({
      kind: 'credit_note',
      driverId: null,
      fleetId: 'flt_1',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      billTo,
      language: 'de',
    });
    // Its sessions are released, so the next fleet invoice bills them again.
    expect(result?.releasedSessionIds).toEqual(['ses_1']);
  });

  it('moves the invoice to credited without changing its content', async () => {
    const result = await creditInvoice('inv_1', 'Wrong tariff');

    const invoiceUpdates = h.state.updates.filter((u) => u.table === 'invoices');
    expect(invoiceUpdates).toHaveLength(1);
    expect(Object.keys(invoiceUpdates[0]?.set ?? {}).sort()).toEqual(['status', 'updatedAt']);
    expect(invoiceUpdates[0]?.set['status']).toBe('credited');
    expect(result?.before.status).toBe('issued');
    expect(result?.original.status).toBe('credited');
    expect(result?.original.totalCents).toBe(476);
  });

  it('releases the sessions for re-billing and keeps fee charges billed', async () => {
    const result = await creditInvoice('inv_1', 'Wrong tariff');

    expect(h.state.updates.filter((u) => u.table === 'chargingSessions')).toEqual([
      { table: 'chargingSessions', set: { invoiceId: null } },
    ]);
    expect(h.state.updates.some((u) => u.table === 'paymentRecords')).toBe(false);
    expect(result?.releasedSessionIds).toEqual(['ses_1']);
  });

  it('locks the invoice row for the credit', async () => {
    await creditInvoice('inv_1', 'Wrong tariff');
    expect(h.state.lockedForUpdate).toBe(true);
  });

  it('credits a paid invoice', async () => {
    h.state.invoice = invoice({ status: 'paid', paidAt: ISSUED });

    const result = await creditInvoice('inv_1', 'Refund');

    expect(result?.original.status).toBe('credited');
  });

  it('writes no -0 amounts for a zero invoice', async () => {
    h.state.invoice = invoice({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
    h.state.lines = [];

    await creditInvoice('inv_1', 'Zero');

    const [note] = h.state.inserted['invoices'] ?? [];
    expect(Object.is(note?.['totalCents'], 0)).toBe(true);
    expect(h.state.inserted['invoiceLineItems']).toBeUndefined();
  });

  it('refuses a second credit with INVOICE_ALREADY_CREDITED', async () => {
    h.state.invoice = invoice({ status: 'credited' });

    await expect(creditInvoice('inv_1', 'Again')).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVOICE_ALREADY_CREDITED',
    });
    expect(h.state.inserted['invoices']).toBeUndefined();
    expect(h.state.updates).toEqual([]);
  });

  it('refuses a credit note with INVOICE_IS_CREDIT_NOTE', async () => {
    h.state.invoice = invoice({ kind: 'credit_note' });

    await expect(creditInvoice('inv_1', 'No')).rejects.toMatchObject({
      code: 'INVOICE_IS_CREDIT_NOTE',
    });
    expect(h.state.inserted['invoices']).toBeUndefined();
  });

  it.each(['draft', 'void'])('refuses a %s invoice with INVOICE_NOT_ISSUED', async (status) => {
    h.state.invoice = invoice({ status });

    await expect(creditInvoice('inv_1', 'No')).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVOICE_NOT_ISSUED',
    });
    expect(h.state.inserted['invoices']).toBeUndefined();
  });

  it('fails when the invoice status changed during the credit', async () => {
    h.state.statusUpdate = [];

    await expect(creditInvoice('inv_1', 'Race')).rejects.toThrow(
      'Invoice changed while it was being credited',
    );
  });

  it('credits once when two credits run at the same time', async () => {
    // FOR UPDATE: the second transaction waits for the first to commit, then
    // reads the credited invoice.
    let lock: Promise<unknown> = Promise.resolve();
    vi.mocked(db.transaction).mockImplementation(((cb: (tx: unknown) => Promise<unknown>) => {
      const run = lock.then(() => cb(db));
      lock = run.catch(() => undefined);
      return run;
    }) as never);

    const results = await Promise.allSettled([
      creditInvoice('inv_1', 'First'),
      creditInvoice('inv_1', 'Second'),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { statusCode: 409, code: 'INVOICE_ALREADY_CREDITED' },
    });
    expect(h.state.inserted['invoices']).toHaveLength(1);
  });

  it('propagates a unique violation of a second credit note and changes nothing more', async () => {
    // The unique index on credited_invoice_id is the last guard.
    vi.mocked(db.insert).mockImplementationOnce((() => ({
      values: () => ({
        returning: () =>
          Promise.reject(Object.assign(new Error('duplicate key value'), { code: '23505' })),
      }),
    })) as never);

    await expect(creditInvoice('inv_1', 'Race')).rejects.toThrow('duplicate key value');
    expect(h.state.updates).toEqual([]);
  });

  it('returns null when the invoice does not exist', async () => {
    h.state.invoice = null;
    expect(await creditInvoice('missing', 'x')).toBeNull();
  });
});
