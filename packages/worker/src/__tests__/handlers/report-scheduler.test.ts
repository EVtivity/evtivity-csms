// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Logger } from 'pino';

// Drizzle chain mock: each method returns the chain; awaiting it pops the next
// preset result off a queue. `setupDbResults(...arrays)` feeds the SELECT /
// UPDATE chains in call order. The handler issues, in order:
//   1. SELECT dueSchedules            (drives runOneSchedule fan-out)
//   then per schedule:
//   2. UPDATE reportSchedules (nextRunAt/lastRunAt)  -> no awaited result needed
//   3. SELECT report (inside waitForReport)
//   4. SELECT users (recipient languages), when there are recipients and SMTP
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'set', 'returning', 'limit'];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

// Tagged-template `client` mock. Each invocation pops the next queued result so
// the company-name SELECT and the notifications INSERT can be asserted/driven
// independently. `client.json` is a passthrough used inside the INSERT.
const clientCalls: unknown[][] = [];
let clientResults: unknown[][] = [];
let clientCallIndex = 0;
function setupClientResults(...results: unknown[][]) {
  clientResults = results;
  clientCallIndex = 0;
}
const mockClient = Object.assign(
  vi.fn((...args: unknown[]) => {
    clientCalls.push(args);
    const r = clientResults[clientCallIndex] ?? [];
    clientCallIndex++;
    return Promise.resolve(r);
  }),
  { json: vi.fn((v: unknown) => v) },
);

vi.mock('@evtivity/database', () => ({
  client: mockClient,
  db: {
    select: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
  },
  reportSchedules: {
    id: 'reportSchedules.id',
    isEnabled: 'reportSchedules.isEnabled',
    nextRunAt: 'reportSchedules.nextRunAt',
  },
  reports: {
    id: 'reports.id',
    status: 'reports.status',
    fileData: 'reports.fileData',
    fileName: 'reports.fileName',
  },
  users: { email: 'users.email', language: 'users.language' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn((col: unknown, values: unknown) => ({ col, values })),
  lte: vi.fn(),
  sql: vi.fn(() => 'now()'),
}));

const mockQueueReport = vi.fn().mockResolvedValue('report-id-123');
const mockComputeNextRunAt = vi.fn().mockResolvedValue(new Date('2026-01-02T06:00:00Z'));
const mockOperatorReportLanguage = vi.fn().mockResolvedValue('en');
const mockRenderReport = vi.fn();
const mockSweepStaleReports = vi.fn().mockResolvedValue({ pending: [], timedOut: 0 });
vi.mock('@evtivity/services/report.service', () => ({
  queueReport: (...args: unknown[]) => mockQueueReport(...args),
  sweepStaleReports: () => mockSweepStaleReports(),
  computeNextRunAtInTz: (...args: unknown[]) => mockComputeNextRunAt(...args),
  operatorReportLanguage: (...args: unknown[]) => mockOperatorReportLanguage(...args),
  renderReport: (...args: unknown[]) => mockRenderReport(...args),
}));

const mockEnqueueReport = vi.fn().mockResolvedValue(undefined);
vi.mock('../../report-worker.js', () => ({
  enqueueReport: (...args: unknown[]) => mockEnqueueReport(...args),
}));

const mockGetNotificationSettings = vi.fn();
const mockSendEmail = vi.fn();
const mockRenderTemplate = vi.fn();
const mockWrapEmailHtml = vi.fn();
vi.mock('@evtivity/lib', () => ({
  getNotificationSettings: (...args: unknown[]) => mockGetNotificationSettings(...args),
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  renderTemplate: (...args: unknown[]) => mockRenderTemplate(...args),
  wrapEmailHtml: (...args: unknown[]) => mockWrapEmailHtml(...args),
}));

type MockLog = Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

function makeLog(): MockLog {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as MockLog;
}

function makeSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sch_1',
    name: 'Daily Sessions',
    reportType: 'sessions',
    format: 'csv',
    filters: { siteId: 'site_1' },
    createdById: 'usr_1',
    frequency: 'daily',
    dayOfWeek: null,
    dayOfMonth: null,
    recipientEmails: ['ops@evtivity.com'],
    ...overrides,
  };
}

const SMTP = { host: 'smtp.test', port: 587 };

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let reportSchedulerModule: typeof import('../../handlers/report-scheduler.js');
let drizzleOrmModule: typeof import('drizzle-orm');
beforeAll(async () => {
  reportSchedulerModule = await import('../../handlers/report-scheduler.js');
  drizzleOrmModule = await import('drizzle-orm');
}, 30_000);

describe('reportSchedulerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    setupClientResults();
    clientCalls.length = 0;
    clientCallIndex = 0;
    mockQueueReport.mockResolvedValue('report-id-123');
    mockSweepStaleReports.mockResolvedValue({ pending: [], timedOut: 0 });
    mockEnqueueReport.mockResolvedValue(undefined);
    mockComputeNextRunAt.mockResolvedValue(new Date('2026-01-02T06:00:00Z'));
    mockOperatorReportLanguage.mockResolvedValue('en');
    mockClient.json.mockImplementation((v: unknown) => v);
  });

  it('attaches the report in each recipient language, reusing the stored file', async () => {
    const schedule = makeSchedule({
      format: 'pdf',
      recipientEmails: ['de1@example.com', 'ko@example.com', 'x@ext.com', 'de2@example.com'],
    });
    setupDbResults(
      [schedule],
      [],
      [{ status: 'completed', fileData: Buffer.from('stored-de'), fileName: 'stored.pdf' }],
      [
        { email: 'de1@example.com', language: 'de' },
        { email: 'ko@example.com', language: 'ko' },
        { email: 'de2@example.com', language: 'de' },
      ],
    );
    setupClientResults([{ value: 'Acme' }], [], [], [], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b' });
    mockSendEmail.mockResolvedValue(true);
    // The schedule creator reads German, so the stored report is the German file.
    mockOperatorReportLanguage.mockResolvedValue('de');
    mockRenderReport.mockImplementation(
      (_type: string, _filters: unknown, _format: string, language: string) =>
        Promise.resolve({ data: Buffer.from(`file-${language}`), fileName: `${language}.pdf` }),
    );

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockOperatorReportLanguage).toHaveBeenCalledWith('usr_1');
    // One file per missing language, with the schedule's type, filters and format.
    expect(mockRenderReport.mock.calls).toEqual([
      ['sessions', { siteId: 'site_1' }, 'pdf', 'ko'],
      ['sessions', { siteId: 'site_1' }, 'pdf', 'en'],
    ]);
    const attached = mockSendEmail.mock.calls.map((c) => {
      const files = c[5] as Array<{ filename: string; contentType: string }>;
      return [c[1], files.map((f) => f.filename), files[0]?.contentType];
    });
    expect(attached).toEqual([
      ['de1@example.com', ['stored.pdf'], 'application/pdf'],
      ['ko@example.com', ['ko.pdf'], 'application/pdf'],
      ['x@ext.com', ['en.pdf'], 'application/pdf'],
      ['de2@example.com', ['stored.pdf'], 'application/pdf'],
    ]);
  });

  it('sends without an attachment when a language fails to render', async () => {
    const schedule = makeSchedule({ recipientEmails: ['ko@example.com', 'ops@evtivity.com'] });
    setupDbResults(
      [schedule],
      [],
      [{ status: 'completed', fileData: Buffer.from('stored'), fileName: 'stored.csv' }],
      [{ email: 'ko@example.com', language: 'ko' }],
    );
    setupClientResults([{ value: 'Acme' }], [], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b' });
    mockSendEmail.mockResolvedValue(true);
    mockRenderReport.mockRejectedValue(new Error('generator failed'));
    const log = makeLog();

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(log);

    expect(mockSendEmail.mock.calls.map((c) => [c[1], c[5]])).toEqual([
      ['ko@example.com', undefined],
      ['ops@evtivity.com', [expect.objectContaining({ filename: 'stored.csv' })]],
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'sch_1', language: 'ko' }),
      'Scheduled report attachment failed in this language, sending without it',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('renders the email once per recipient language and falls back to en', async () => {
    const schedule = makeSchedule({
      recipientEmails: ['Ko.Op@Example.com', 'de.op@example.com', 'ko2@example.com', 'x@ext.com'],
    });
    setupDbResults(
      [schedule],
      [],
      [{ status: 'completed', fileData: Buffer.from('a'), fileName: 'r.csv' }],
      [
        { email: 'ko.op@example.com', language: 'ko' },
        { email: 'DE.OP@example.com', language: 'de' },
        { email: 'ko2@example.com', language: 'ko' },
      ],
    );
    setupClientResults([{ value: 'Acme' }], [], [], [], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockImplementation((_c: string, _e: string, language: string) =>
      Promise.resolve({ subject: `subject-${language}`, body: `body-${language}` }),
    );
    mockSendEmail.mockResolvedValue(true);

    const { inArray } = drizzleOrmModule;
    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    // The lookup is case-insensitive: lowercased, deduplicated addresses.
    expect(vi.mocked(inArray).mock.calls.at(-1)?.[1]).toEqual([
      'ko.op@example.com',
      'de.op@example.com',
      'ko2@example.com',
      'x@ext.com',
    ]);
    // One render per language, in the language of each recipient.
    expect(mockRenderTemplate.mock.calls.map((c) => c[2])).toEqual(['ko', 'de', 'en']);
    expect(mockSendEmail.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['Ko.Op@Example.com', 'subject-ko'],
      ['de.op@example.com', 'subject-de'],
      ['ko2@example.com', 'subject-ko'],
      ['x@ext.com', 'subject-en'],
    ]);
    const inserts = clientCalls.filter((c) => String(c[0]).includes('INSERT INTO notifications'));
    expect(inserts.map((c) => c[2])).toEqual([
      'subject-ko',
      'subject-de',
      'subject-ko',
      'subject-en',
    ]);
  });

  it('does nothing when no schedules are due', async () => {
    setupDbResults([]);
    const { reportSchedulerHandler } = reportSchedulerModule;
    const log = makeLog();
    await expect(reportSchedulerHandler(log)).resolves.toBeUndefined();
    expect(mockQueueReport).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('queues stale pending reports again and logs the sweep', async () => {
    setupDbResults([]);
    mockSweepStaleReports.mockResolvedValue({ pending: ['rpt_a', 'rpt_b'], timedOut: 1 });
    const log = makeLog();

    await reportSchedulerModule.reportSchedulerHandler(log);

    expect(mockEnqueueReport).toHaveBeenCalledWith('rpt_a');
    expect(mockEnqueueReport).toHaveBeenCalledWith('rpt_b');
    expect(log.info).toHaveBeenCalledWith({ requeued: 2, timedOut: 1 }, 'Stale reports swept');
  });

  it('stays quiet when the sweep finds nothing', async () => {
    setupDbResults([]);
    const log = makeLog();

    await reportSchedulerModule.reportSchedulerHandler(log);

    expect(mockSweepStaleReports).toHaveBeenCalledTimes(1);
    expect(mockEnqueueReport).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs a sweep failure and still runs the due schedules', async () => {
    setupDbResults([makeSchedule({ recipientEmails: [] })]);
    mockSweepStaleReports.mockRejectedValue(new Error('db down'));
    const log = makeLog();

    await reportSchedulerModule.reportSchedulerHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Report sweep failed',
    );
    expect(mockQueueReport).toHaveBeenCalledTimes(1);
  });

  it('can be imported and the function is exported', async () => {
    const mod = reportSchedulerModule;
    expect(typeof mod.reportSchedulerHandler).toBe('function');
  });

  it('queues report, advances next run, generates CSV, and emails wrapped HTML', async () => {
    const schedule = makeSchedule({ format: 'csv' });
    const nextRun = new Date('2026-01-02T06:00:00Z');
    mockComputeNextRunAt.mockResolvedValue(nextRun);
    setupDbResults(
      [schedule], // dueSchedules
      [], // UPDATE reportSchedules (nextRunAt/lastRunAt)
      [{ status: 'completed', fileData: Buffer.from('a,b,c'), fileName: 'sessions.csv' }], // waitForReport
    );
    setupClientResults(
      [{ value: 'Acme Charging' }], // company.name SELECT
      [], // notifications INSERT
    );
    mockGetNotificationSettings.mockResolvedValue({
      smtp: SMTP,
      emailWrapperTemplate: '<wrap>{{{content}}}</wrap>',
    });
    mockRenderTemplate.mockResolvedValue({
      subject: 'Your scheduled report',
      body: 'plain body',
      html: '<p>report</p>',
    });
    mockWrapEmailHtml.mockReturnValue('<wrap><p>report</p></wrap>');
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    const log = makeLog();
    await reportSchedulerHandler(log);

    // queueReport receives the schedule's identity and filters verbatim and
    // queues the generation on the worker's report queue.
    expect(mockQueueReport).toHaveBeenCalledWith(
      {
        name: 'Daily Sessions',
        reportType: 'sessions',
        format: 'csv',
        filters: { siteId: 'site_1' },
        userId: 'usr_1',
      },
      expect.any(Function),
    );
    const dispatch = mockQueueReport.mock.calls[0]?.[1] as (id: string) => Promise<void>;
    await dispatch('report-id-123');
    expect(mockEnqueueReport).toHaveBeenCalledWith('report-id-123');
    // Schedule advancement computed from the schedule cadence.
    expect(mockComputeNextRunAt).toHaveBeenCalledWith('daily', null, null);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'sch_1', reportId: 'report-id-123' }),
      'Scheduled report queued',
    );
    // Wrapped HTML built from the rendered template html.
    expect(mockWrapEmailHtml).toHaveBeenCalledWith(
      '<p>report</p>',
      'Acme Charging',
      '<wrap>{{{content}}}</wrap>',
      expect.objectContaining({ companyName: 'Acme Charging', reportName: 'Daily Sessions' }),
    );
    // Email dispatched with CSV attachment and wrapped HTML.
    expect(mockSendEmail).toHaveBeenCalledWith(
      SMTP,
      'ops@evtivity.com',
      'Your scheduled report',
      'plain body',
      '<wrap><p>report</p></wrap>',
      [
        {
          filename: 'sessions.csv',
          content: expect.any(Buffer),
          contentType: 'text/csv',
        },
      ],
    );
    // Notification row persisted as 'sent'.
    const insertCall = clientCalls.find((c) => String(c[0]).includes('INSERT INTO notifications'));
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain('sent');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('uses default company name when the company.name setting is absent', async () => {
    setupDbResults(
      [makeSchedule()],
      [],
      [{ status: 'completed', fileData: Buffer.from('x'), fileName: 'r.csv' }],
    );
    setupClientResults([], []); // empty company.name rows
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
    mockWrapEmailHtml.mockReturnValue('<wrapped>');
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockWrapEmailHtml).toHaveBeenCalledWith(
      '<p>h</p>',
      'EVtivity CSMS',
      null,
      expect.objectContaining({ companyName: 'EVtivity CSMS' }),
    );
  });

  it('selects the xlsx content type for xlsx-format reports', async () => {
    setupDbResults(
      [makeSchedule({ format: 'xlsx' })],
      [],
      [{ status: 'completed', fileData: Buffer.from('xl'), fileName: 'r.xlsx' }],
    );
    setupClientResults([{ value: 'Acme' }], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
    mockWrapEmailHtml.mockReturnValue('<w>');
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockSendEmail).toHaveBeenCalledWith(SMTP, 'ops@evtivity.com', 's', 'b', '<w>', [
      expect.objectContaining({
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ]);
  });

  it('falls back to octet-stream content type for an unknown format', async () => {
    setupDbResults(
      [makeSchedule({ format: 'json' })],
      [],
      [{ status: 'completed', fileData: Buffer.from('{}'), fileName: 'r.json' }],
    );
    setupClientResults([{ value: 'Acme' }], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
    mockWrapEmailHtml.mockReturnValue('<w>');
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockSendEmail).toHaveBeenCalledWith(SMTP, 'ops@evtivity.com', 's', 'b', '<w>', [
      expect.objectContaining({ contentType: 'application/octet-stream' }),
    ]);
  });

  it('records a failed notification status when sendEmail returns false', async () => {
    setupDbResults(
      [makeSchedule()],
      [],
      [{ status: 'completed', fileData: Buffer.from('x'), fileName: 'r.csv' }],
    );
    setupClientResults([{ value: 'Acme' }], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
    mockWrapEmailHtml.mockReturnValue('<w>');
    mockSendEmail.mockResolvedValue(false);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    const insertCall = clientCalls.find((c) => String(c[0]).includes('INSERT INTO notifications'));
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain('failed');
  });

  it('treats null filters as an empty object', async () => {
    setupDbResults([makeSchedule({ filters: null, recipientEmails: [] })]);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP });

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockQueueReport).toHaveBeenCalledWith(
      expect.objectContaining({ filters: {} }),
      expect.any(Function),
    );
  });

  it('stores no user when the schedule has no creator', async () => {
    setupDbResults([makeSchedule({ createdById: null, recipientEmails: null })]);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockQueueReport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null }),
      expect.any(Function),
    );
  });

  it('returns before emailing when the schedule has no recipients', async () => {
    setupDbResults([makeSchedule({ recipientEmails: [] })]);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockGetNotificationSettings).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns before emailing when recipientEmails is null', async () => {
    setupDbResults([makeSchedule({ recipientEmails: null })]);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockGetNotificationSettings).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('skips email when SMTP is not configured', async () => {
    setupDbResults(
      [makeSchedule()],
      [{ status: 'completed', fileData: Buffer.from('x'), fileName: 'r.csv' }],
    );
    mockGetNotificationSettings.mockResolvedValue({ smtp: null });

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRenderTemplate).not.toHaveBeenCalled();
  });

  it('emails without an attachment when the report never completes', async () => {
    setupDbResults(
      [makeSchedule()],
      [],
      [{ status: 'failed', fileData: null, fileName: null }], // waitForReport -> null
    );
    setupClientResults([{ value: 'Acme' }], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
    mockWrapEmailHtml.mockReturnValue('<w>');
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    const log = makeLog();
    await reportSchedulerHandler(log);

    // No attachment passed (undefined as the 6th arg).
    expect(mockSendEmail).toHaveBeenCalledWith(
      SMTP,
      'ops@evtivity.com',
      's',
      'b',
      '<w>',
      undefined,
    );
    expect(log.warn).toHaveBeenCalledWith(
      { reportId: 'report-id-123' },
      'Scheduled report generation failed, skipping email attachment',
    );
  });

  it('sends plain body (no wrapped html) when the rendered template has no html', async () => {
    setupDbResults(
      [makeSchedule()],
      [],
      [{ status: 'completed', fileData: Buffer.from('x'), fileName: 'r.csv' }],
    );
    setupClientResults([{ value: 'Acme' }], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'plain only', html: null });
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockWrapEmailHtml).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith(
      SMTP,
      'ops@evtivity.com',
      's',
      'plain only',
      undefined,
      [expect.objectContaining({ filename: 'r.csv' })],
    );
    // The stored body falls back to rendered.body when wrappedHtml is undefined.
    const insertCall = clientCalls.find((c) => String(c[0]).includes('INSERT INTO notifications'));
    expect(insertCall).toBeDefined();
  });

  it('isolates a failing schedule and logs the error without aborting the tick', async () => {
    setupDbResults([makeSchedule()]);
    mockQueueReport.mockRejectedValue(new Error('queue exploded'));

    const { reportSchedulerHandler } = reportSchedulerModule;
    const log = makeLog();
    await expect(reportSchedulerHandler(log)).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'sch_1', error: expect.any(Error) }),
      'Failed to run scheduled report',
    );
  });

  it('continues processing other schedules when one fails (Promise.allSettled)', async () => {
    // Two due schedules; the first throws, the second succeeds end-to-end.
    setupDbResults(
      [makeSchedule({ id: 'sch_bad' }), makeSchedule({ id: 'sch_ok', recipientEmails: [] })],
      // sch_bad has no recipients path because queueReport throws first;
      // sch_ok queues then returns early (no recipients).
    );
    mockQueueReport.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('report-ok');

    const { reportSchedulerHandler } = reportSchedulerModule;
    const log = makeLog();
    await reportSchedulerHandler(log);

    expect(mockQueueReport).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(1);
    // The surviving schedule still advanced its next run.
    expect(mockComputeNextRunAt).toHaveBeenCalled();
  });

  it('emails without an attachment when the report row is missing entirely', async () => {
    setupDbResults(
      [makeSchedule()],
      [], // UPDATE reportSchedules
      [], // waitForReport SELECT returns no row -> null
    );
    setupClientResults([{ value: 'Acme' }], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
    mockWrapEmailHtml.mockReturnValue('<w>');
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockSendEmail).toHaveBeenCalledWith(
      SMTP,
      'ops@evtivity.com',
      's',
      'b',
      '<w>',
      undefined,
    );
  });

  it('polls until the report completes, sleeping between pending statuses', async () => {
    vi.useFakeTimers();
    try {
      setupDbResults(
        [makeSchedule()],
        [], // UPDATE reportSchedules
        [{ status: 'processing', fileData: null, fileName: null }], // poll 1: not done -> sleep
        [{ status: 'completed', fileData: Buffer.from('x'), fileName: 'r.csv' }], // poll 2: done
      );
      setupClientResults([{ value: 'Acme' }], []);
      mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
      mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
      mockWrapEmailHtml.mockReturnValue('<w>');
      mockSendEmail.mockResolvedValue(true);

      const { reportSchedulerHandler } = reportSchedulerModule;
      const promise = reportSchedulerHandler(makeLog());
      // Advance past the 5s poll interval so the second poll runs.
      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      // The CSV from the second (completed) poll was attached.
      expect(mockSendEmail).toHaveBeenCalledWith(SMTP, 'ops@evtivity.com', 's', 'b', '<w>', [
        expect.objectContaining({ filename: 'r.csv', contentType: 'text/csv' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the poll timeout and emails without an attachment', async () => {
    vi.useFakeTimers();
    try {
      // dueSchedules + UPDATE, then 60 pending polls. The chain mock returns
      // [] for any call past the queued results, and an empty SELECT means a
      // missing report -> early null. To keep the loop running we hand every
      // poll a non-terminal 'processing' row by re-arming the mock.
      const pendingRow = { status: 'processing', fileData: null, fileName: null };
      const pollResults = Array.from({ length: 60 }, () => [pendingRow]);
      // Then the recipient language lookup (no user account: en).
      setupDbResults([makeSchedule()], [], ...pollResults, []);
      setupClientResults([{ value: 'Acme' }], []);
      mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
      mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
      mockWrapEmailHtml.mockReturnValue('<w>');
      mockSendEmail.mockResolvedValue(true);

      const { reportSchedulerHandler } = reportSchedulerModule;
      const log = makeLog();
      const promise = reportSchedulerHandler(log);
      // 60 polls * 5s interval drains the loop to the timeout branch.
      await vi.advanceTimersByTimeAsync(60 * 5000);
      await promise;

      expect(log.warn).toHaveBeenCalledWith(
        { reportId: 'report-id-123' },
        'Scheduled report did not complete within timeout',
      );
      expect(mockSendEmail).toHaveBeenCalledWith(
        SMTP,
        'ops@evtivity.com',
        's',
        'b',
        '<w>',
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a completed report with no file data as no attachment', async () => {
    setupDbResults(
      [makeSchedule()],
      [],
      [{ status: 'completed', fileData: null, fileName: null }], // completed but empty -> null
    );
    setupClientResults([{ value: 'Acme' }], []);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
    mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
    mockWrapEmailHtml.mockReturnValue('<w>');
    mockSendEmail.mockResolvedValue(true);

    const { reportSchedulerHandler } = reportSchedulerModule;
    await reportSchedulerHandler(makeLog());

    expect(mockSendEmail).toHaveBeenCalledWith(
      SMTP,
      'ops@evtivity.com',
      's',
      'b',
      '<w>',
      undefined,
    );
  });
});
