// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  },
  reportSchedules: {},
  reports: {},
}));

vi.mock('@evtivity/api/src/services/report.service.js', () => ({
  queueReport: vi.fn().mockResolvedValue('report-id-123'),
}));

vi.mock('@evtivity/lib', () => ({
  getNotificationSettings: vi.fn(),
  sendEmail: vi.fn(),
  renderTemplate: vi.fn(),
  wrapEmailHtml: vi.fn(),
}));

vi.mock('postgres', () => ({
  default: vi.fn(() => {
    const sql = Object.assign(
      vi.fn(() => Promise.resolve([])),
      {
        end: vi.fn(() => Promise.resolve()),
      },
    );
    return sql;
  }),
}));

describe('reportSchedulerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no schedules are due', async () => {
    const { reportSchedulerHandler } = await import('../../handlers/report-scheduler.js');
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never;
    await expect(reportSchedulerHandler(log)).resolves.toBeUndefined();
  });

  it('can be imported and the function is exported', async () => {
    const mod = await import('../../handlers/report-scheduler.js');
    expect(typeof mod.reportSchedulerHandler).toBe('function');
  });
});
