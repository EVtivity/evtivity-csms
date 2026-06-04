// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Drizzle chain mock: each method returns the chain; awaiting it pops the next
// preset result off a queue. `setupDbResults(...arrays)` feeds the SELECT /
// UPDATE chains in call order. The handler issues, in order:
//   1. SELECT dueSchedules            (drives runOneSchedule fan-out)
//   then per schedule:
//   2. UPDATE reportSchedules (nextRunAt/lastRunAt)  -> no awaited result needed
//   3. SELECT report (inside waitForReport)
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
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  sql: vi.fn(() => 'now()'),
}));

const mockQueueReport = vi.fn().mockResolvedValue('report-id-123');
const mockComputeNextRunAt = vi.fn().mockResolvedValue(new Date('2026-01-02T06:00:00Z'));
vi.mock('@evtivity/api/src/services/report.service.js', () => ({
  queueReport: (...args: unknown[]) => mockQueueReport(...args),
  computeNextRunAtInTz: (...args: unknown[]) => mockComputeNextRunAt(...args),
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

describe('reportSchedulerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    setupClientResults();
    clientCalls.length = 0;
    clientCallIndex = 0;
    mockQueueReport.mockResolvedValue('report-id-123');
    mockComputeNextRunAt.mockResolvedValue(new Date('2026-01-02T06:00:00Z'));
    mockClient.json.mockImplementation((v: unknown) => v);
  });

  it('does nothing when no schedules are due', async () => {
    setupDbResults([]);
    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
    const log = makeLog();
    await expect(reportSchedulerHandler(log)).resolves.toBeUndefined();
    expect(mockQueueReport).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('can be imported and the function is exported', async () => {
    const mod = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
    const log = makeLog();
    await reportSchedulerHandler(log);

    // queueReport receives the schedule's identity and filters verbatim.
    expect(mockQueueReport).toHaveBeenCalledWith({
      name: 'Daily Sessions',
      reportType: 'sessions',
      format: 'csv',
      filters: { siteId: 'site_1' },
      userId: 'usr_1',
    });
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
    await reportSchedulerHandler(makeLog());

    const insertCall = clientCalls.find((c) => String(c[0]).includes('INSERT INTO notifications'));
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain('failed');
  });

  it('treats null filters as an empty object', async () => {
    setupDbResults([makeSchedule({ filters: null, recipientEmails: [] })]);
    mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP });

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
    await reportSchedulerHandler(makeLog());

    expect(mockQueueReport).toHaveBeenCalledWith(expect.objectContaining({ filters: {} }));
  });

  it('falls back to empty userId when createdById is null', async () => {
    setupDbResults([makeSchedule({ createdById: null, recipientEmails: null })]);

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
    await reportSchedulerHandler(makeLog());

    expect(mockQueueReport).toHaveBeenCalledWith(expect.objectContaining({ userId: '' }));
  });

  it('returns before emailing when the schedule has no recipients', async () => {
    setupDbResults([makeSchedule({ recipientEmails: [] })]);

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
    await reportSchedulerHandler(makeLog());

    expect(mockGetNotificationSettings).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns before emailing when recipientEmails is null', async () => {
    setupDbResults([makeSchedule({ recipientEmails: null })]);

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

      const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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
      const pollResults = Array.from({ length: 61 }, () => [pendingRow]);
      setupDbResults([makeSchedule()], [], ...pollResults);
      setupClientResults([{ value: 'Acme' }], []);
      mockGetNotificationSettings.mockResolvedValue({ smtp: SMTP, emailWrapperTemplate: null });
      mockRenderTemplate.mockResolvedValue({ subject: 's', body: 'b', html: '<p>h</p>' });
      mockWrapEmailHtml.mockReturnValue('<w>');
      mockSendEmail.mockResolvedValue(true);

      const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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

    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
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
