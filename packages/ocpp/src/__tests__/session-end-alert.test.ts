// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { Logger } from '@evtivity/lib';

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock('../server/notification-dispatcher.js', () => ({
  ALL_TEMPLATES_DIRS: ['/ocpp/templates', '/api/templates'],
  dispatchSystemNotification: mockDispatch,
}));

import {
  notifySessionEndFailed,
  SESSION_END_FAILED_EVENT,
  SESSION_END_FAILED_PERMISSION,
} from '../server/session-end-alert.js';

const sessionRow = {
  transaction_id: 'tx-1',
  started_at: new Date('2026-06-01T00:00:00Z'),
  ended_at: new Date('2026-06-01T02:00:00Z'),
  end_request_reason: 'GhostRecovered',
  end_attempts: 5,
  station_ocpp_id: 'CS-001',
  site_id: 'sit_1',
  site_name: 'Downtown',
};

const operator = {
  id: 'usr_1',
  email: 'ops@example.com',
  phone: '+15550100',
  first_name: 'Ada',
  last_name: 'Ops',
  language: 'de',
  timezone: 'Europe/Berlin',
};

function makeSql(
  session: Record<string, unknown>[],
  users: Record<string, unknown>[],
): { sql: postgres.Sql; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(text.includes('FROM users u') ? users : session);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

const makeLogger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

describe('notifySessionEndFailed', () => {
  beforeEach(() => {
    mockDispatch.mockReset().mockResolvedValue(undefined);
  });

  it('alerts each operator with session write access to the site, with the session details', async () => {
    const second = { ...operator, id: 'usr_2', email: 'lead@example.com', phone: null };
    const { sql, calls } = makeSql([sessionRow], [operator, second]);
    const log = makeLogger();

    await notifySessionEndFailed(sql, 'ses_1', log as unknown as Logger);

    const recipientQuery = calls.find((c) => c.text.includes('FROM users u'));
    expect(recipientQuery?.text).toContain('u.is_active');
    expect(recipientQuery?.text).toContain('u.has_all_site_access');
    expect(recipientQuery?.values).toEqual([SESSION_END_FAILED_PERMISSION, 'sit_1']);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(mockDispatch).toHaveBeenNthCalledWith(
      1,
      sql,
      SESSION_END_FAILED_EVENT,
      {
        email: 'ops@example.com',
        phone: '+15550100',
        firstName: 'Ada',
        lastName: 'Ops',
        language: 'de',
        timezone: 'Europe/Berlin',
        userId: 'usr_1',
      },
      {
        sessionId: 'ses_1',
        stationId: 'CS-001',
        siteName: 'Downtown',
        transactionId: 'tx-1',
        endRequestReason: 'GhostRecovered',
        attempts: 5,
        startedAt: '2026-06-01T00:00:00.000Z',
        endedAt: '2026-06-01T02:00:00.000Z',
      },
      ['/ocpp/templates', '/api/templates'],
    );
    expect(mockDispatch.mock.calls[1]?.[2]).toMatchObject({
      email: 'lead@example.com',
      phone: undefined,
      userId: 'usr_2',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('sends empty site and times for a station without a site', async () => {
    const { sql } = makeSql(
      [{ ...sessionRow, site_id: null, site_name: null, started_at: null }],
      [operator],
    );
    await notifySessionEndFailed(sql, 'ses_1', makeLogger() as unknown as Logger);
    expect(mockDispatch.mock.calls[0]?.[3]).toMatchObject({ siteName: '', startedAt: '' });
  });

  it('sends nothing for an unknown session', async () => {
    const { sql } = makeSql([], [operator]);
    await notifySessionEndFailed(sql, 'ses_1', makeLogger() as unknown as Logger);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('logs a warning when no operator can be alerted', async () => {
    const { sql } = makeSql([sessionRow], []);
    const log = makeLogger();
    await notifySessionEndFailed(sql, 'ses_1', log as unknown as Logger);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      { sessionId: 'ses_1' },
      'No operator to alert about a session whose end failed',
    );
  });

  it('fails open: a dispatch error is logged at warn and not thrown (P9)', async () => {
    mockDispatch.mockRejectedValue(new Error('smtp down'));
    const { sql } = makeSql([sessionRow], [operator]);
    const log = makeLogger();
    await expect(
      notifySessionEndFailed(sql, 'ses_1', log as unknown as Logger),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1' }),
      'Failed to alert operators about a session whose end failed',
    );
  });
});
