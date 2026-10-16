// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: Array<Record<string, unknown>> = [];
const tables: unknown[] = [];
let insertError: Error | null = null;

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/database')>();
  return {
    ...actual,
    db: {
      insert: vi.fn((table: unknown) => {
        tables.push(table);
        return {
          values: vi.fn((v: Record<string, unknown>) => {
            if (insertError != null) return Promise.reject(insertError);
            rows.push(v);
            return Promise.resolve();
          }),
        };
      }),
    },
  };
});

const { reportScheduleAuditLog } = await import('@evtivity/database');
const { writeReportGeneratedAudit, writeReportDownloadedAudit } =
  await import('../report-audit.js');

describe('report audit', () => {
  beforeEach(() => {
    rows.length = 0;
    tables.length = 0;
    insertError = null;
  });

  it('records a generated report with its filters and scope, never its contents', async () => {
    await writeReportGeneratedAudit(
      {
        reportId: 'rpt_1',
        name: 'Q1 Revenue',
        reportType: 'revenue',
        format: 'csv',
        filters: { dateFrom: '2026-01-01', dateTo: '2026-03-31', siteId: 'sit_1' },
        siteScope: ['sit_1'],
        scheduleId: 4,
      },
      { actor: 'system', actorLabel: 'report-scheduler' },
    );
    expect(tables).toEqual([reportScheduleAuditLog]);
    expect(rows[0]).toMatchObject({
      reportScheduleId: '4',
      reportScheduleIdSnapshot: 'report:rpt_1',
      action: 'report_generated',
      actor: 'system',
      actorLabel: 'report-scheduler',
      before: null,
      after: {
        reportId: 'rpt_1',
        name: 'Q1 Revenue',
        reportType: 'revenue',
        format: 'csv',
        filters: { dateFrom: '2026-01-01', dateTo: '2026-03-31', siteId: 'sit_1' },
        siteScope: ['sit_1'],
        scheduleId: 4,
      },
      notes: 'rpt_1',
    });
    expect(JSON.stringify(rows[0])).not.toContain('fileData');
  });

  it('files an on-demand report under no schedule', async () => {
    await writeReportGeneratedAudit(
      {
        reportId: 'rpt_2',
        name: 'Energy',
        reportType: 'energy',
        format: 'xlsx',
        filters: {},
        siteScope: null,
        scheduleId: null,
      },
      { actor: 'operator', actorUserId: 'usr_1' },
    );
    expect(rows[0]).toMatchObject({ reportScheduleId: null, actorUserId: 'usr_1' });
  });

  it('writes nothing for a report that was not queued', async () => {
    await writeReportGeneratedAudit(
      {
        reportId: '',
        name: 'Energy',
        reportType: 'energy',
        format: 'csv',
        filters: {},
        siteScope: null,
        scheduleId: null,
      },
      { actor: 'operator', actorUserId: 'usr_1' },
    );
    expect(rows).toHaveLength(0);
  });

  it('records a download', async () => {
    await writeReportDownloadedAudit(
      {
        reportId: 'rpt_3',
        name: 'Sessions',
        reportType: 'sessions',
        format: 'csv',
        fileName: 'sessions.csv',
      },
      { actor: 'api_key', actorUserId: 'usr_1', actorApiKeyId: 'key_1' },
    );
    expect(rows[0]).toMatchObject({
      reportScheduleId: null,
      reportScheduleIdSnapshot: 'report:rpt_3',
      action: 'report_downloaded',
      actor: 'api_key',
      actorApiKeyId: 'key_1',
      after: { reportId: 'rpt_3', fileName: 'sessions.csv' },
    });
  });

  it('fails open: an insert error is logged and never thrown', async () => {
    insertError = new Error('db down');
    const logger = { warn: vi.fn() };
    await expect(
      writeReportGeneratedAudit(
        {
          reportId: 'rpt_4',
          name: 'Energy',
          reportType: 'energy',
          format: 'csv',
          filters: {},
          siteScope: null,
          scheduleId: null,
        },
        { actor: 'operator', actorUserId: 'usr_1' },
        logger,
      ),
    ).resolves.toBeUndefined();
    await expect(
      writeReportDownloadedAudit(
        { reportId: 'rpt_4', name: 'E', reportType: 'energy', format: 'csv', fileName: 'e.csv' },
        { actor: 'operator', actorUserId: 'usr_1' },
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
