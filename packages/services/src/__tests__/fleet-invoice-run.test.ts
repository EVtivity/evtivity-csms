// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface RunState {
  statements: Array<{ text: string; values: unknown[] }>;
  fleetRows: Array<{ fleet_id: string; period: string }>;
  memberRows: Array<{ fleet_id: string; driver_id: string; period: string }>;
  pendingFailures: number;
  claimedFailures: Array<Record<string, unknown>>;
  failRecord: boolean;
  operatorRows: Array<Record<string, unknown>>;
  overdueRows: Array<{ id: string }>;
  // Rows the overdue claim returns (empty: claimed before).
  claimRows: Array<{ id: string }>;
  contacts: { emails: string[]; language: string | null };
  details: Map<string, unknown>;
  failOperators: boolean;
}

const h = vi.hoisted(
  (): RunState => ({
    statements: [],
    fleetRows: [],
    memberRows: [],
    pendingFailures: 0,
    claimedFailures: [],
    failRecord: false,
    operatorRows: [],
    overdueRows: [],
    claimRows: [],
    contacts: { emails: [], language: null },
    details: new Map(),
    failOperators: false,
  }),
);

vi.mock('@evtivity/database', () => ({
  client: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    h.statements.push({ text, values });
    if (text.includes('fleet_member_invoice_run_failures r')) return Promise.resolve(h.memberRows);
    if (text.includes('auto_invoice')) return Promise.resolve(h.fleetRows);
    if (text.includes('::int AS n')) return Promise.resolve([{ n: h.pendingFailures }]);
    if (text.includes('UPDATE fleet_invoice_run_failures')) {
      return Promise.resolve(h.claimedFailures);
    }
    if (
      text.includes('INSERT INTO fleet_invoice_run_failures') ||
      text.includes('INSERT INTO fleet_member_invoice_run_failures')
    ) {
      return h.failRecord ? Promise.reject(new Error('fk violation')) : Promise.resolve([]);
    }
    if (text.includes('FROM users u')) {
      return h.failOperators
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(h.operatorRows);
    }
    if (text.includes('UPDATE invoices SET overdue_notice_sent_at')) {
      return Promise.resolve(h.claimRows);
    }
    if (text.includes('SELECT i.id FROM invoices i')) return Promise.resolve(h.overdueRows);
    return Promise.resolve([]);
  }),
  db: {},
  invoiceAuditLog: { name: 'invoice_audit_log' },
  getSystemTimezone: vi.fn(() => Promise.resolve('Europe/Berlin')),
  loadFleetBillingContacts: vi.fn(() => Promise.resolve(h.contacts)),
  writeAudit: vi.fn(() => Promise.resolve()),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  dispatchSystemNotification: vi.fn((_sql: unknown, _event: string, to: { email: string }) =>
    Promise.resolve({ delivered: [{ channel: 'email', recipient: to.email }] }),
  ),
  dispatchDriverNotification: vi.fn(() =>
    Promise.resolve({ delivered: [{ channel: 'email', recipient: 'mia@example.com' }] }),
  ),
}));

vi.mock('../fleet-invoice.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fleet-invoice.service.js')>()),
  createFleetInvoice: vi.fn(),
  createMemberInvoice: vi.fn(),
  findPeriodInvoice: vi.fn(),
  findMemberPeriodInvoice: vi.fn(),
}));

const pubsub = vi.hoisted(() => ({ publish: vi.fn(() => Promise.resolve()) }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => pubsub }));

vi.mock('../fleet-invoice-notice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fleet-invoice-notice.js')>()),
  sendAccountInvoiceEmail: vi.fn(() => Promise.resolve({ status: 'sent', recipients: 1 })),
}));

vi.mock('../invoice-audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../invoice-audit.js')>()),
  writeInvoiceSentAudit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../invoice.service.js', () => ({
  getInvoice: vi.fn((id: string) => Promise.resolve(h.details.get(id) ?? null)),
}));

vi.mock('../invoice-pdf.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../invoice-pdf.service.js')>()),
  generateInvoicePdf: vi.fn(() => Promise.resolve(Buffer.from('%PDF-1.3'))),
}));

import { writeAudit } from '@evtivity/database';
import { AppError, dispatchDriverNotification, dispatchSystemNotification } from '@evtivity/lib';
import {
  createFleetInvoice,
  createMemberInvoice,
  findMemberPeriodInvoice,
  findPeriodInvoice,
} from '../fleet-invoice.service.js';
import { sendAccountInvoiceEmail } from '../fleet-invoice-notice.js';
import { writeInvoiceSentAudit } from '../invoice-audit.js';
import { generateInvoicePdf } from '../invoice-pdf.service.js';
import {
  ACCOUNT_INVOICE_JOB_OPTIONS,
  MEMBER_INVOICE_JOB_NAME,
  MEMBER_INVOICE_QUEUE,
} from '../account-invoice-jobs.js';
import {
  FLEET_INVOICE_OVERDUE_EVENT,
  FLEET_INVOICE_RUN_FAILED_EVENT,
  enqueueMemberInvoiceBatch,
  fleetInvoiceJobId,
  fleetInvoiceRunFailureVariables,
  groupFailuresByPeriod,
  loadFleetsToInvoice,
  loadMembersToInvoice,
  memberInvoiceJobId,
  recordFleetInvoiceRunFailure,
  recordMemberInvoiceRunFailure,
  runMemberInvoiceJob,
  sendMemberInvoiceOverdueNotices,
  runScheduledFleetInvoice,
  scheduledRunPeriod,
  sendFleetInvoiceOverdueNotice,
  sendFleetInvoiceOverdueNotices,
  sendFleetInvoiceRunFailureDigests,
  sendMemberInvoiceOverdueNotice,
} from '../fleet-invoice-run.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const deps = { templatesDirs: ['/templates'] };
const now = new Date('2026-10-20T10:00:00Z');

function invoiceDetail(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    invoice: {
      id,
      invoiceNumber: `INV-202610-${id}`,
      kind: 'invoice',
      status: 'issued',
      fleetId: 'flt_1',
      periodStart: '2026-09-01',
      language: 'de',
      issuedAt: new Date('2026-10-01T09:00:00Z'),
      dueAt: new Date('2026-10-15T09:00:00Z'),
      totalCents: 4165,
      currency: 'EUR',
      creditReason: null,
      ...overrides,
    },
    lineItems: [{ sessionId: 'ses_1' }, { sessionId: 'ses_2' }],
    driver: null,
    fleet: { id: 'flt_1', name: 'Acme Logistics' },
    taxBreakdown: [],
    creditedInvoice: null,
    creditNote: null,
  };
}

function createdInvoice(): unknown {
  return {
    invoice: { id: 'inv_new', invoiceNumber: 'INV-202610-0001' },
    lineItems: [{ sessionId: 'ses_1' }, { sessionId: 'ses_1' }, { sessionId: null }],
    drivers: [],
    excluded: [],
    excludedCount: 2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.statements = [];
  h.fleetRows = [];
  h.memberRows = [];
  h.pendingFailures = 0;
  h.claimedFailures = [];
  h.failRecord = false;
  h.operatorRows = [];
  h.overdueRows = [];
  h.claimRows = [{ id: 'inv_1' }];
  h.contacts = { emails: ['ap@acme.test', 'cfo@acme.test'], language: 'en' };
  h.details = new Map();
  h.failOperators = false;
});

describe('scheduledRunPeriod', () => {
  it('bills the previous month from the run day on', () => {
    expect(scheduledRunPeriod(new Date('2026-10-01T10:00:00Z'), 'UTC', 1)).toBe('2026-09');
    expect(scheduledRunPeriod(new Date('2026-10-05T10:00:00Z'), 'UTC', 5)).toBe('2026-09');
    expect(scheduledRunPeriod(new Date('2026-10-31T10:00:00Z'), 'UTC', 5)).toBe('2026-09');
  });

  it('bills nothing before the run day', () => {
    expect(scheduledRunPeriod(new Date('2026-10-04T23:00:00Z'), 'UTC', 5)).toBeNull();
  });

  it('reads the day in the system timezone', () => {
    const instant = new Date('2026-10-01T23:30:00Z');
    // Already 2 October in Berlin, still 1 October in UTC.
    expect(scheduledRunPeriod(instant, 'Europe/Berlin', 2)).toBe('2026-09');
    expect(scheduledRunPeriod(instant, 'UTC', 2)).toBeNull();
    // Still 30 September in Los Angeles: September has not ended there, August is billed.
    expect(scheduledRunPeriod(new Date('2026-10-01T03:00:00Z'), 'America/Los_Angeles', 1)).toBe(
      '2026-08',
    );
  });

  it('bills December in January', () => {
    expect(scheduledRunPeriod(new Date('2027-01-02T12:00:00Z'), 'UTC', 1)).toBe('2026-12');
  });
});

describe('fleetInvoiceJobId', () => {
  it('is deterministic per fleet and month and has no colon (BullMQ custom ids)', () => {
    expect(fleetInvoiceJobId('flt_1', '2026-09')).toBe('fleet-invoice.flt_1.2026-09');
    expect(fleetInvoiceJobId('flt_1', '2026-09')).not.toContain(':');
  });
});

describe('loadFleetsToInvoice', () => {
  it('lists each auto invoice fleet with its oldest month to bill', async () => {
    h.fleetRows = [
      { fleet_id: 'flt_1', period: '2026-08' },
      { fleet_id: 'flt_2', period: '2026-09' },
    ];
    await expect(loadFleetsToInvoice('2026-09', 'Europe/Berlin', 'eur')).resolves.toEqual([
      { fleetId: 'flt_1', period: '2026-08' },
      { fleetId: 'flt_2', period: '2026-09' },
    ]);
    const statement = h.statements[0];
    const text = statement?.text ?? '';
    expect(text).toContain('f.auto_invoice');
    // The oldest month in the system timezone, up to the end of the latest month.
    expect(text).toContain("to_char(min(u.period_start), 'YYYY-MM')");
    expect(text).toContain("date_trunc('month', cs.ended_at AT TIME ZONE ?)");
    // The sessions the fleet invoice would bill: a cost in the company currency.
    expect(text).toContain("cs.billing_mode = 'account'");
    expect(text).toContain('NOT cs.member_billed');
    expect(text).toContain('NOT i.member_billed');
    expect(text).toContain('cs.final_cost_cents > 0');
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM payment_records');
    expect(text).toContain('cs.invoice_id IS NULL');
    expect(text).not.toContain('invoice_line_items');
    // A month with an invoice in any status (a credited one is left to the
    // operator) or a recorded run failure is not billed by the run.
    expect(text).toContain("i.period_start = u.period_start AND i.kind = 'invoice'");
    expect(text).toContain('FROM fleet_invoice_run_failures r');
    expect(statement?.values).toEqual(['Europe/Berlin', '2026-09-30T22:00:00.000Z', 'EUR']);
  });

  it('computes months in UTC when the system timezone is invalid', async () => {
    await loadFleetsToInvoice('2026-09', 'Not/AZone', 'EUR');
    expect(h.statements[0]?.values).toEqual(['UTC', '2026-10-01T00:00:00.000Z', 'EUR']);
  });
});

describe('runScheduledFleetInvoice', () => {
  it('issues the invoice, audits it as the system run and emails it once', async () => {
    vi.mocked(createFleetInvoice).mockResolvedValue(createdInvoice() as never);

    const result = await runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now);

    expect(result).toEqual({ status: 'invoiced', invoiceId: 'inv_new', email: 'sent' });
    // Only the month's own sessions: an earlier month gets its own invoice.
    expect(createFleetInvoice).toHaveBeenCalledWith('flt_1', '2026-09', now, { periodOnly: true });
    const audit = vi.mocked(writeAudit).mock.calls[0]?.[1];
    expect(audit).toMatchObject({
      entityId: 'inv_new',
      action: 'invoice_generated',
      actor: 'system',
      actorLabel: 'fleet-invoice-run',
      notes: '2026-09',
    });
    expect(audit?.after).toMatchObject({ sessionIds: ['ses_1'], excludedCount: 2 });
    expect(sendAccountInvoiceEmail).toHaveBeenCalledWith('inv_new', 'once', deps, {
      actor: { actor: 'system', actorLabel: 'fleet-invoice-run' },
      log,
    });
  });

  it('answers nothing to bill and an unknown fleet without failing', async () => {
    vi.mocked(createFleetInvoice).mockRejectedValueOnce(
      new AppError('none', 409, 'FLEET_INVOICE_NOTHING_TO_BILL'),
    );
    await expect(runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now)).resolves.toEqual({
      status: 'nothing_to_bill',
    });
    vi.mocked(createFleetInvoice).mockRejectedValueOnce(
      new AppError('gone', 404, 'FLEET_NOT_FOUND'),
    );
    await expect(runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now)).resolves.toEqual({
      status: 'fleet_not_found',
    });
    expect(sendAccountInvoiceEmail).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('emails an existing live invoice of the period once instead of issuing a second (rerun)', async () => {
    vi.mocked(createFleetInvoice).mockRejectedValue(
      new AppError('exists', 409, 'FLEET_INVOICE_PERIOD_EXISTS'),
    );
    vi.mocked(findPeriodInvoice).mockResolvedValue({
      id: 'inv_live',
      invoiceNumber: 'INV-202610-0001',
      status: 'issued',
    });
    vi.mocked(sendAccountInvoiceEmail).mockResolvedValue({ status: 'already_sent' });

    const result = await runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now);

    expect(result).toEqual({ status: 'exists', invoiceId: 'inv_live', email: 'already_sent' });
    expect(findPeriodInvoice).toHaveBeenCalledWith({}, 'flt_1', '2026-09-01');
    expect(sendAccountInvoiceEmail).toHaveBeenCalledWith('inv_live', 'once', deps, {
      actor: { actor: 'system', actorLabel: 'fleet-invoice-run' },
      log,
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('rethrows other errors so the job retries', async () => {
    vi.mocked(createFleetInvoice).mockRejectedValue(new Error('connection lost'));
    await expect(runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now)).rejects.toThrow(
      'connection lost',
    );
    vi.mocked(createFleetInvoice).mockRejectedValue(
      new AppError('raced', 400, 'INVOICE_CREATION_FAILED'),
    );
    await expect(runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now)).rejects.toThrow(
      'raced',
    );
  });

  it('rethrows an email failure (the retry sends it through the existing invoice)', async () => {
    vi.mocked(createFleetInvoice).mockResolvedValue(createdInvoice() as never);
    vi.mocked(sendAccountInvoiceEmail).mockRejectedValue(new Error('pdf failed'));
    await expect(runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now)).rejects.toThrow(
      'pdf failed',
    );
  });

  it('warns when the fleet has no billing contact', async () => {
    vi.mocked(createFleetInvoice).mockResolvedValue(createdInvoice() as never);
    vi.mocked(sendAccountInvoiceEmail).mockResolvedValue({ status: 'no_contacts' });
    const result = await runScheduledFleetInvoice('flt_1', '2026-09', deps, log, now);
    expect(result).toEqual({ status: 'invoiced', invoiceId: 'inv_new', email: 'no_contacts' });
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('recordFleetInvoiceRunFailure', () => {
  it('records an issued invoice that was not emailed', async () => {
    vi.mocked(findPeriodInvoice).mockResolvedValue({
      id: 'inv_live',
      invoiceNumber: 'INV-202610-0007',
      status: 'issued',
    });
    const long = 'x'.repeat(400);

    await expect(recordFleetInvoiceRunFailure('flt_1', '2026-09', long, log)).resolves.toBe(
      'issued_not_emailed',
    );

    expect(findPeriodInvoice).toHaveBeenCalledWith({}, 'flt_1', '2026-09-01');
    const insert = h.statements.find((s) =>
      s.text.includes('INSERT INTO fleet_invoice_run_failures'),
    );
    expect(insert?.values.slice(0, 3)).toEqual(['flt_1', '2026-09-01', 'INV-202610-0007']);
    expect(insert?.values[3]).toHaveLength(300);
    // A month that fails again is reported again.
    expect(insert?.text).toContain('reported_at = NULL');
  });

  it('records a month that was not invoiced', async () => {
    vi.mocked(findPeriodInvoice).mockResolvedValue(null);
    await expect(recordFleetInvoiceRunFailure('flt_1', '2026-09', 'db down', log)).resolves.toBe(
      'not_invoiced',
    );
    const insert = h.statements.find((s) =>
      s.text.includes('INSERT INTO fleet_invoice_run_failures'),
    );
    expect(insert?.values.slice(0, 4)).toEqual(['flt_1', '2026-09-01', null, 'db down']);
  });

  it('is fail-open: a failed write is logged at error and resolves null', async () => {
    vi.mocked(findPeriodInvoice).mockResolvedValue(null);
    h.failRecord = true;
    await expect(recordFleetInvoiceRunFailure('flt_1', '2026-09', 'e', log)).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('fleetInvoiceRunFailureVariables', () => {
  it('lists issued and not invoiced fleets with the reason of each', () => {
    const variables = fleetInvoiceRunFailureVariables('2026-09', [
      {
        fleetId: 'flt_1',
        fleetName: 'Acme',
        period: '2026-09',
        invoiceNumber: 'INV-1',
        errorMessage: 'smtp timeout',
      },
      {
        fleetId: 'flt_2',
        fleetName: 'Beta',
        period: '2026-09',
        invoiceNumber: null,
        errorMessage: 'db down',
      },
      {
        fleetId: 'flt_3',
        fleetName: 'Gamma',
        period: '2026-09',
        invoiceNumber: null,
        errorMessage: 'stalled',
      },
    ]);
    expect(variables).toEqual({
      period: '2026-09',
      fleetCount: 3,
      fleetNames: 'Acme, Beta, Gamma',
      memberCount: 0,
      issuedNotEmailedCount: 1,
      issuedNotEmailed: 'Acme (INV-1): smtp timeout',
      notInvoicedCount: 2,
      notInvoiced: 'Beta: db down; Gamma: stalled',
    });
  });

  it('names the driver of a member invoice and lists each fleet once', () => {
    const variables = fleetInvoiceRunFailureVariables('2026-09', [
      {
        fleetId: 'f',
        fleetName: 'Acme',
        period: '2026-09',
        invoiceNumber: null,
        errorMessage: 'e1',
      },
      {
        fleetId: 'f',
        fleetName: 'Acme',
        driverName: 'Mia Meyer',
        period: '2026-09',
        invoiceNumber: 'INV-2',
        errorMessage: 'smtp',
      },
      {
        fleetId: 'f',
        fleetName: 'Acme',
        driverName: 'Jo Kim',
        period: '2026-09',
        invoiceNumber: null,
        errorMessage: 'db',
      },
    ]);
    expect(variables).toMatchObject({
      fleetCount: 1,
      fleetNames: 'Acme',
      memberCount: 2,
      issuedNotEmailed: 'Acme, Mia Meyer (INV-2): smtp',
      notInvoiced: 'Acme: e1; Acme, Jo Kim: db',
    });
  });

  it('leaves a list empty when no fleet is in it (the template hides the section)', () => {
    const variables = fleetInvoiceRunFailureVariables('2026-09', [
      { fleetId: 'f', fleetName: 'F', period: '2026-09', invoiceNumber: null, errorMessage: 'e' },
    ]);
    expect(variables['issuedNotEmailed']).toBe('');
    expect(variables['issuedNotEmailedCount']).toBe(0);
  });
});

describe('groupFailuresByPeriod', () => {
  it('keeps months and fleets in order', () => {
    const row = (fleetId: string, period: string) => ({
      fleetId,
      fleetName: fleetId,
      period,
      invoiceNumber: null,
      errorMessage: 'e',
    });
    const grouped = groupFailuresByPeriod([
      row('a', '2026-08'),
      row('b', '2026-09'),
      row('c', '2026-08'),
    ]);
    expect([...grouped.keys()]).toEqual(['2026-08', '2026-09']);
    expect(grouped.get('2026-08')?.map((r) => r.fleetId)).toEqual(['a', 'c']);
  });
});

describe('sendFleetInvoiceRunFailureDigests', () => {
  const operators = [
    { id: 'usr_1', email: 'ops@cpo.test', phone: '+491', first_name: 'Ana', last_name: 'B' },
    { id: 'usr_2', email: 'fin@cpo.test', phone: null, first_name: null, last_name: null },
  ];

  it('sends one notice per month to every operator who issues invoices, listing the fleets', async () => {
    h.pendingFailures = 3;
    h.operatorRows = operators;
    h.claimedFailures = [
      {
        fleet_id: 'flt_1',
        name: 'Acme',
        period: '2026-08',
        invoice_number: null,
        error_message: 'e1',
      },
      {
        fleet_id: 'flt_2',
        name: 'Beta',
        period: '2026-09',
        invoice_number: 'INV-9',
        error_message: 'e2',
      },
      {
        fleet_id: 'flt_3',
        name: null,
        period: '2026-09',
        invoice_number: null,
        error_message: 'e3',
      },
    ];

    await expect(sendFleetInvoiceRunFailureDigests(deps, log)).resolves.toEqual({
      periods: 2,
      fleets: 3,
    });

    const operatorQuery = h.statements.find((s) => s.text.includes('FROM users u'));
    expect(operatorQuery?.values).toEqual(['payments:write']);
    // The claim takes only unreported rows, so replicas never send a fleet twice.
    const claim = h.statements.find((s) => s.text.includes('UPDATE fleet_invoice_run_failures'));
    expect(claim?.text).toContain('WHERE reported_at IS NULL');
    const calls = vi.mocked(dispatchSystemNotification).mock.calls;
    // Two months, two operators each.
    expect(calls).toHaveLength(4);
    expect(calls[0]?.[1]).toBe(FLEET_INVOICE_RUN_FAILED_EVENT);
    expect(calls[0]?.[2]).toMatchObject({
      email: 'ops@cpo.test',
      firstName: 'Ana',
      userId: 'usr_1',
    });
    expect(calls[0]?.[3]).toMatchObject({
      period: '2026-08',
      fleetNames: 'Acme',
      notInvoiced: 'Acme: e1',
    });
    expect(calls[2]?.[3]).toMatchObject({
      period: '2026-09',
      fleetCount: 2,
      // A deleted fleet is named by its id.
      fleetNames: 'Beta, flt_3',
      issuedNotEmailed: 'Beta (INV-9): e2',
      notInvoiced: 'flt_3: e3',
    });
  });

  it('claims fleet and member failures in one statement and names the member driver', async () => {
    h.pendingFailures = 2;
    h.operatorRows = [operators[0] as Record<string, unknown>];
    h.claimedFailures = [
      {
        fleet_id: 'flt_1',
        name: 'Acme',
        driver_id: null,
        first_name: null,
        last_name: null,
        period: '2026-09',
        invoice_number: null,
        error_message: 'e1',
      },
      {
        fleet_id: 'flt_1',
        name: 'Acme',
        driver_id: 'drv_1',
        first_name: 'Mia',
        last_name: 'Meyer',
        period: '2026-09',
        invoice_number: null,
        error_message: 'e2',
      },
    ];

    await expect(sendFleetInvoiceRunFailureDigests(deps, log)).resolves.toEqual({
      periods: 1,
      fleets: 2,
    });
    const pending = h.statements.find((st) => st.text.includes('::int AS n'));
    expect(pending?.text).toContain('fleet_member_invoice_run_failures WHERE reported_at IS NULL');
    const claim = h.statements.find((st) => st.text.includes('UPDATE fleet_invoice_run_failures'));
    expect(claim?.text).toContain(
      'UPDATE fleet_member_invoice_run_failures SET reported_at = now()',
    );
    expect(vi.mocked(dispatchSystemNotification).mock.calls[0]?.[3]).toMatchObject({
      fleetNames: 'Acme',
      notInvoiced: 'Acme: e1; Acme, Mia Meyer: e2',
    });
  });

  it('claims nothing when no failure waits or no operator would get it', async () => {
    await expect(sendFleetInvoiceRunFailureDigests(deps, log)).resolves.toEqual({
      periods: 0,
      fleets: 0,
    });
    expect(h.statements.some((s) => s.text.includes('FROM users u'))).toBe(false);

    h.pendingFailures = 1;
    await sendFleetInvoiceRunFailureDigests(deps, log);
    expect(h.statements.some((s) => s.text.includes('UPDATE fleet_invoice_run_failures'))).toBe(
      false,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('is fail-open: a failed read resolves with nothing sent', async () => {
    h.pendingFailures = 1;
    h.failOperators = true;
    await expect(sendFleetInvoiceRunFailureDigests(deps, log)).resolves.toEqual({
      periods: 0,
      fleets: 0,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('sendFleetInvoiceOverdueNotice', () => {
  it('claims and emails an issued invoice past its due date to each contact with the PDF', async () => {
    h.details.set('inv_1', invoiceDetail('inv_1'));

    await expect(sendFleetInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('sent');

    const claim = h.statements.find((s) => s.text.includes('UPDATE invoices'));
    expect(claim?.text).toContain('overdue_notice_sent_at IS NULL');
    expect(claim?.text).toContain("status = 'issued'");
    const calls = vi.mocked(dispatchSystemNotification).mock.calls;
    expect(calls.map((c) => (c[2] as { email: string }).email)).toEqual([
      'ap@acme.test',
      'cfo@acme.test',
    ]);
    expect(calls[0]?.[1]).toBe(FLEET_INVOICE_OVERDUE_EVENT);
    expect(calls[0]?.[2]).toMatchObject({ language: 'de', timezone: 'Europe/Berlin' });
    expect(calls[0]?.[3]).toMatchObject({
      invoiceNumber: 'INV-202610-inv_1',
      fleetName: 'Acme Logistics',
    });
    expect(calls[0]?.[5]).toEqual([
      expect.objectContaining({ filename: 'INV-202610-inv_1.pdf', contentType: 'application/pdf' }),
    ]);
    expect(writeInvoiceSentAudit).toHaveBeenCalledWith(
      {
        invoiceId: 'inv_1',
        invoiceNumber: 'INV-202610-inv_1',
        eventType: FLEET_INVOICE_OVERDUE_EVENT,
        delivered: [
          { channel: 'email', recipient: 'ap@acme.test' },
          { channel: 'email', recipient: 'cfo@acme.test' },
        ],
        resend: false,
        actor: { actor: 'system', actorLabel: 'fleet-invoice-run' },
      },
      undefined,
    );
  });

  it('sends once: a claim taken before sends nothing', async () => {
    h.details.set('inv_1', invoiceDetail('inv_1'));
    h.claimRows = [];
    await expect(sendFleetInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('already_sent');
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
    expect(writeInvoiceSentAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['not due yet', { dueAt: new Date('2026-10-25T09:00:00Z') }],
    ['paid', { status: 'paid' }],
    ['credited', { status: 'credited' }],
    ['a credit note', { kind: 'credit_note' }],
    ['a driver invoice', { fleetId: null }],
    ['a member invoice', { memberBilled: true }],
  ])('leaves an invoice that is %s', async (_label, overrides) => {
    h.details.set('inv_1', invoiceDetail('inv_1', overrides));
    await expect(sendFleetInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('not_overdue');
    expect(h.statements.some((s) => s.text.includes('UPDATE invoices'))).toBe(false);
  });

  it('does not claim without a billing contact, so a contact added later gets it', async () => {
    h.details.set('inv_1', invoiceDetail('inv_1'));
    h.contacts = { emails: [], language: 'en' };
    await expect(sendFleetInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('no_contacts');
    expect(h.statements.some((s) => s.text.includes('UPDATE invoices'))).toBe(false);
    expect(generateInvoicePdf).not.toHaveBeenCalled();
  });

  it('answers not found for an unknown invoice', async () => {
    await expect(sendFleetInvoiceOverdueNotice('inv_x', deps, now)).resolves.toBe('not_found');
  });
});

describe('sendMemberInvoiceOverdueNotice', () => {
  const driver = { id: 'drv_1', firstName: 'Mia', lastName: 'M', email: 'mia@example.com' };
  function memberDetail(overrides: Record<string, unknown> = {}): unknown {
    return {
      ...(invoiceDetail('inv_1', {
        memberBilled: true,
        driverId: 'drv_1',
        ...overrides,
      }) as object),
      driver,
    };
  }

  it('claims and sends invoice.MemberOverdue to the driver only, with the PDF and no SMS', async () => {
    h.details.set('inv_1', memberDetail());

    await expect(sendMemberInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('sent');

    const claim = h.statements.find((s) => s.text.includes('UPDATE invoices'));
    expect(claim?.text).toContain('overdue_notice_sent_at IS NULL');
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
    const call = vi.mocked(dispatchDriverNotification).mock.calls[0];
    expect(call?.[1]).toBe('invoice.MemberOverdue');
    expect(call?.[2]).toBe('drv_1');
    expect(call?.[3]).toMatchObject({ invoiceId: 'inv_1', fleetName: 'Acme Logistics' });
    expect(call?.[6]).toEqual({
      attachments: [
        expect.objectContaining({
          filename: 'INV-202610-inv_1.pdf',
          contentType: 'application/pdf',
        }),
      ],
      sms: false,
    });
    expect(vi.mocked(writeInvoiceSentAudit).mock.calls[0]?.[0]).toMatchObject({
      eventType: 'invoice.MemberOverdue',
      actor: { actor: 'system', actorLabel: 'fleet-invoice-run' },
    });
  });

  it('does not claim when the driver has no email, so the reminder goes once one is added', async () => {
    h.details.set('inv_1', { ...(memberDetail() as object), driver: { ...driver, email: '' } });
    await expect(sendMemberInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('no_email');
    h.details.set('inv_1', { ...(memberDetail() as object), driver: null });
    await expect(sendMemberInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('no_driver');
    expect(h.statements.some((s) => s.text.includes('UPDATE invoices'))).toBe(false);
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('sends once and leaves a fleet invoice or one not due', async () => {
    h.details.set('inv_1', memberDetail());
    h.claimRows = [];
    await expect(sendMemberInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('already_sent');
    h.details.set('inv_1', memberDetail({ memberBilled: false }));
    await expect(sendMemberInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('not_overdue');
    h.details.set('inv_1', memberDetail({ dueAt: new Date('2026-10-25T09:00:00Z') }));
    await expect(sendMemberInvoiceOverdueNotice('inv_1', deps, now)).resolves.toBe('not_overdue');
    await expect(sendMemberInvoiceOverdueNotice('inv_x', deps, now)).resolves.toBe('not_found');
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });
});

describe('sendFleetInvoiceOverdueNotices', () => {
  it('selects issued fleet invoices past due with a contact and goes on after a failure', async () => {
    h.overdueRows = [{ id: 'inv_1' }, { id: 'inv_2' }, { id: 'inv_3' }];
    h.details.set('inv_1', invoiceDetail('inv_1'));
    h.details.set('inv_3', invoiceDetail('inv_3'));
    vi.mocked(generateInvoicePdf)
      .mockRejectedValueOnce(new Error('render failed'))
      .mockResolvedValue(Buffer.from('%PDF-1.3'));

    const summary = await sendFleetInvoiceOverdueNotices(deps, log, now);

    // inv_1 failed to render, inv_2 is unknown, inv_3 was sent.
    expect(summary).toEqual({ sent: 1, noContacts: 0, failed: 1 });
    const select = h.statements[0];
    expect(select?.text).toContain("i.status = 'issued'");
    // Member invoices go to their driver, never to the fleet contacts.
    expect(select?.text).toContain('NOT i.member_billed');
    expect(select?.text).toContain('i.overdue_notice_sent_at IS NULL');
    expect(select?.text).toContain('cardinality(f.billing_contact_emails) > 0');
    expect(select?.values).toEqual([now, 500]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('memberInvoiceJobId', () => {
  it('is deterministic per fleet, driver and month, plus the batch, with no colon', () => {
    expect(memberInvoiceJobId('flt_1', 'drv_1', '2026-09')).toBe(
      'member-invoice.flt_1.drv_1.2026-09',
    );
    expect(memberInvoiceJobId('flt_1', 'drv_1', '2026-09', 'b-1')).toBe(
      'member-invoice.flt_1.drv_1.2026-09.b-1',
    );
    expect(memberInvoiceJobId('flt_1', 'drv_1', '2026-09')).not.toContain(':');
  });
});

describe('loadMembersToInvoice', () => {
  it('lists each driver of an auto invoice fleet with the oldest month to bill', async () => {
    h.memberRows = [{ fleet_id: 'flt_1', driver_id: 'drv_1', period: '2026-08' }];
    await expect(loadMembersToInvoice('2026-09', 'Europe/Berlin', 'eur')).resolves.toEqual([
      { fleetId: 'flt_1', driverId: 'drv_1', period: '2026-08' },
    ]);
    const query = h.statements[0];
    expect(query?.text).toContain('f.auto_invoice');
    expect(query?.text).toContain('AND cs.member_billed');
    // Any member invoice of the month (credited too) and a recorded failure leave it out.
    expect(query?.text).toContain('AND i.member_billed');
    expect(query?.text).toContain('fleet_member_invoice_run_failures r');
    expect(query?.values).toContain('EUR');
  });
});

describe('runMemberInvoiceJob', () => {
  beforeEach(() => {
    // Drop any queued one-off answer an earlier test left unused.
    vi.mocked(sendAccountInvoiceEmail)
      .mockReset()
      .mockResolvedValue({ status: 'sent', recipients: 1 });
  });

  function created(): unknown {
    return {
      invoice: { id: 'inv_m', invoiceNumber: 'INV-202610-0002' },
      lineItems: [{ sessionId: 'ses_1' }],
      drivers: [],
      excluded: [],
      excludedCount: 0,
    };
  }

  it('issues a scheduled member invoice for the month only, audited as the system run', async () => {
    vi.mocked(createMemberInvoice).mockResolvedValue(created() as never);

    const result = await runMemberInvoiceJob(
      { fleetId: 'flt_1', driverId: 'drv_1', period: '2026-09' },
      deps,
      log,
      now,
    );

    expect(result).toEqual({ status: 'invoiced', invoiceId: 'inv_m', email: 'sent' });
    expect(createMemberInvoice).toHaveBeenCalledWith('flt_1', 'drv_1', '2026-09', now, {
      periodOnly: true,
    });
    expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
      action: 'invoice_generated',
      actor: 'system',
      actorLabel: 'fleet-invoice-run',
      notes: '2026-09',
    });
    expect(sendAccountInvoiceEmail).toHaveBeenCalledWith('inv_m', 'once', deps, {
      actor: { actor: 'system', actorLabel: 'fleet-invoice-run' },
      log,
    });
  });

  it('issues a batch member invoice without a lower bound, audited for the requester', async () => {
    vi.mocked(createMemberInvoice).mockResolvedValue(created() as never);
    const actor = { actor: 'operator' as const, actorUserId: 'usr_1', actorApiKeyId: null };

    await runMemberInvoiceJob(
      { fleetId: 'flt_1', driverId: 'drv_1', period: '2026-09', batchId: 'b1', actor },
      deps,
      log,
      now,
    );

    expect(createMemberInvoice).toHaveBeenCalledWith('flt_1', 'drv_1', '2026-09', now, {
      periodOnly: false,
    });
    expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
      actor: 'operator',
      actorUserId: 'usr_1',
      actorLabel: 'member-invoice-batch',
    });
  });

  it('sends the live invoice of an issued period once instead of issuing a second', async () => {
    vi.mocked(createMemberInvoice).mockRejectedValue(
      new AppError('exists', 409, 'FLEET_INVOICE_PERIOD_EXISTS'),
    );
    vi.mocked(findMemberPeriodInvoice).mockResolvedValue({
      id: 'inv_live',
      invoiceNumber: 'INV-1',
      status: 'issued',
    });
    vi.mocked(sendAccountInvoiceEmail).mockResolvedValueOnce({ status: 'already_sent' });

    const result = await runMemberInvoiceJob(
      { fleetId: 'flt_1', driverId: 'drv_1', period: '2026-09' },
      deps,
      log,
      now,
    );
    expect(result).toEqual({ status: 'exists', invoiceId: 'inv_live', email: 'already_sent' });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['FLEET_INVOICE_NOTHING_TO_BILL', 'nothing_to_bill'],
    ['FLEET_NOT_FOUND', 'fleet_not_found'],
    ['DRIVER_NOT_FOUND', 'driver_not_found'],
  ])('completes on %s', async (code, status) => {
    vi.mocked(createMemberInvoice).mockRejectedValue(new AppError('x', 409, code));
    await expect(
      runMemberInvoiceJob({ fleetId: 'f', driverId: 'd', period: '2026-09' }, deps, log, now),
    ).resolves.toEqual({ status });
    expect(sendAccountInvoiceEmail).not.toHaveBeenCalled();
  });

  it('rethrows other errors so the job retries, and warns for a driver without email', async () => {
    vi.mocked(createMemberInvoice).mockRejectedValueOnce(new Error('db down'));
    await expect(
      runMemberInvoiceJob({ fleetId: 'f', driverId: 'd', period: '2026-09' }, deps, log, now),
    ).rejects.toThrow('db down');

    vi.mocked(createMemberInvoice).mockResolvedValue(created() as never);
    vi.mocked(sendAccountInvoiceEmail).mockResolvedValueOnce({ status: 'no_email' });
    await expect(
      runMemberInvoiceJob({ fleetId: 'f', driverId: 'd', period: '2026-09' }, deps, log, now),
    ).resolves.toMatchObject({ status: 'invoiced', email: 'no_email' });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('recordMemberInvoiceRunFailure', () => {
  it('records the driver, the month and the live invoice number', async () => {
    vi.mocked(findMemberPeriodInvoice).mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-7',
      status: 'issued',
    });
    await expect(
      recordMemberInvoiceRunFailure('flt_1', 'drv_1', '2026-09', 'smtp', log),
    ).resolves.toBe('issued_not_emailed');
    const insert = h.statements.find((st) =>
      st.text.includes('INSERT INTO fleet_member_invoice_run_failures'),
    );
    expect(insert?.text).toContain('ON CONFLICT (fleet_id, driver_id, period_start)');
    expect(insert?.values).toEqual(['flt_1', 'drv_1', '2026-09-01', 'INV-7', 'smtp']);
  });

  it('is fail-open: a failed write is logged at error and resolves null', async () => {
    vi.mocked(findMemberPeriodInvoice).mockResolvedValue(null);
    h.failRecord = true;
    await expect(
      recordMemberInvoiceRunFailure('flt_1', 'drv_1', '2026-09', 'x', log),
    ).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('sendMemberInvoiceOverdueNotices', () => {
  it('selects issued member invoices past due whose driver has an email', async () => {
    h.overdueRows = [];
    await expect(sendMemberInvoiceOverdueNotices(deps, log, now)).resolves.toEqual({
      sent: 0,
      failed: 0,
    });
    const select = h.statements[0];
    expect(select?.text).toContain('i.member_billed');
    expect(select?.text).toContain('i.overdue_notice_sent_at IS NULL');
    expect(select?.text).toContain("coalesce(d.email, '') <> ''");
    expect(select?.values).toEqual([now, 500]);
  });

  it('goes on after a failure (fail-open per invoice)', async () => {
    h.overdueRows = [{ id: 'inv_1' }, { id: 'inv_2' }];
    const driver = { id: 'drv_1', firstName: 'Mia', lastName: 'M', email: 'mia@example.com' };
    h.details.set('inv_2', {
      ...(invoiceDetail('inv_2', { memberBilled: true, driverId: 'drv_1' }) as object),
      driver,
    });
    h.claimRows = [{ id: 'inv_2' }];
    vi.mocked(generateInvoicePdf).mockResolvedValue(Buffer.from('%PDF-1.3'));
    h.details.set('inv_1', {
      ...(invoiceDetail('inv_1', { memberBilled: true, driverId: 'drv_1' }) as object),
      driver,
    });
    vi.mocked(generateInvoicePdf).mockRejectedValueOnce(new Error('render failed'));

    await expect(sendMemberInvoiceOverdueNotices(deps, log, now)).resolves.toEqual({
      sent: 1,
      failed: 1,
    });
  });
});

describe('enqueueMemberInvoiceBatch', () => {
  const actor = { actor: 'operator' as const, actorUserId: 'usr_1', actorApiKeyId: null };
  const batch = {
    fleetId: 'flt_1',
    period: '2026-09',
    batchId: 'b1',
    actor,
    driverIds: ['drv_1', 'drv_2'],
  };

  it('adds one member invoice job per driver in one addBulk, job id per batch', async () => {
    const queue = { addBulk: vi.fn(() => Promise.resolve([])) };
    await enqueueMemberInvoiceBatch(queue, batch);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk).toHaveBeenCalledWith(
      ['drv_1', 'drv_2'].map((driverId) => ({
        name: MEMBER_INVOICE_JOB_NAME,
        data: { fleetId: 'flt_1', driverId, period: '2026-09', batchId: 'b1', actor },
        opts: { jobId: `member-invoice.flt_1.${driverId}.2026-09.b1` },
      })),
    );
    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('gives a repeated add of the same batch the same job ids', async () => {
    const queue = { addBulk: vi.fn(() => Promise.resolve([])) };
    await enqueueMemberInvoiceBatch(queue, batch);
    await enqueueMemberInvoiceBatch(queue, batch);
    const ids = queue.addBulk.mock.calls.map((call) =>
      (call as unknown as [Array<{ opts: { jobId: string } }>])[0].map((j) => j.opts.jobId),
    );
    expect(ids[0]).toEqual(ids[1]);
  });

  it('adds nothing without drivers and throws a failed add', async () => {
    const queue = { addBulk: vi.fn(() => Promise.reject(new Error('NOPERM'))) };
    await enqueueMemberInvoiceBatch(queue, { ...batch, driverIds: [] });
    expect(queue.addBulk).not.toHaveBeenCalled();
    await expect(enqueueMemberInvoiceBatch(queue, batch)).rejects.toThrow('NOPERM');
  });

  it('uses the invoice job options of the worker queues', () => {
    expect(ACCOUNT_INVOICE_JOB_OPTIONS).toEqual({
      removeOnComplete: { age: 40 * 24 * 60 * 60 },
      removeOnFail: { age: 40 * 24 * 60 * 60 },
      attempts: 6,
      backoff: { type: 'exponential', delay: 300_000 },
    });
    expect(MEMBER_INVOICE_QUEUE).toBe('member-invoices');
  });
});
