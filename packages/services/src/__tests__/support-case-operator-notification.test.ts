// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbResults: unknown[][] = [];
// One entry per query: the builder calls it made, in order.
const queries: Array<Array<{ method: string; args: unknown[] }>> = [];

vi.mock('@evtivity/database', () => {
  function makeQuery() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    queries.push(calls);
    const query: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
      query[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return query;
      };
    }
    query['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve, reject);
    return query;
  }
  return {
    db: { select: vi.fn(() => makeQuery()) },
    client: {},
    users: {
      id: 'users.id',
      email: 'users.email',
      phone: 'users.phone',
      language: 'users.language',
      timezone: 'users.timezone',
      roleId: 'users.roleId',
      isActive: 'users.isActive',
      createdAt: 'users.createdAt',
    },
    roles: { id: 'roles.id', name: 'roles.name' },
    isSupportEnabled: vi.fn().mockResolvedValue(true),
    chargingSessions: {},
    chargingStations: {},
    supportCaseSessions: {},
    supportCases: {},
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ eq: [col, value] }),
  and: (...conds: unknown[]) => ({ and: conds }),
  asc: (col: unknown) => ({ asc: col }),
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dispatchSystemNotification: vi.fn().mockResolvedValue(undefined) };
});

import { dispatchSystemNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '../template-dirs.js';
import { dispatchOperatorNotification } from '../support-case-notify.js';

const OPERATOR = {
  userId: 'usr_1',
  email: 'op@example.com',
  phone: null,
  language: 'en',
  timezone: 'Europe/Berlin',
};
const ADMIN = {
  userId: 'usr_admin',
  email: 'admin@example.com',
  phone: '+15550001111',
  language: 'de',
  timezone: 'America/Chicago',
};

function whereOf(index: number): unknown {
  return queries[index]?.find((c) => c.method === 'where')?.args[0];
}

describe('dispatchOperatorNotification', () => {
  beforeEach(() => {
    dbResults.length = 0;
    queries.length = 0;
    vi.mocked(dispatchSystemNotification).mockClear();
  });

  // Finding J2: a dispatch without the template directories (or with a path
  // that does not exist in the image) sends the notification unrendered.
  it('renders from the API and OCPP template directories', async () => {
    dbResults.push([OPERATOR]);

    await dispatchOperatorNotification('new_case', 'case_1', 'SC-1', 'Help', 'usr_1');

    expect(dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      'supportCase.NewCaseFromDriver',
      expect.objectContaining({ email: 'op@example.com', userId: 'usr_1' }),
      expect.objectContaining({ caseNumber: 'SC-1' }),
      ALL_TEMPLATES_DIRS,
    );
  });

  it('sends to the active assignee in their language and timezone', async () => {
    dbResults.push([OPERATOR]);

    await dispatchOperatorNotification('driver_reply', 'case_1', 'SC-1', 'Help', 'usr_1');

    expect(queries).toHaveLength(1);
    expect(whereOf(0)).toEqual({
      and: [{ eq: ['users.id', 'usr_1'] }, { eq: ['users.isActive', true] }],
    });
    expect(dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      'supportCase.DriverReply',
      {
        email: 'op@example.com',
        phone: undefined,
        userId: 'usr_1',
        language: 'en',
        timezone: 'Europe/Berlin',
      },
      expect.anything(),
      ALL_TEMPLATES_DIRS,
    );
  });

  it('falls back to the earliest active admin when the assignee is inactive', async () => {
    dbResults.push([], [ADMIN]);

    await dispatchOperatorNotification('driver_reply', 'case_1', 'SC-1', 'Help', 'usr_gone');

    expect(queries).toHaveLength(2);
    const adminQuery = queries[1] ?? [];
    expect(adminQuery.find((c) => c.method === 'where')?.args[0]).toEqual({
      and: [{ eq: ['roles.name', 'admin'] }, { eq: ['users.isActive', true] }],
    });
    expect(adminQuery.find((c) => c.method === 'orderBy')?.args).toEqual([
      { asc: 'users.createdAt' },
      { asc: 'users.id' },
    ]);
    expect(adminQuery.find((c) => c.method === 'limit')?.args).toEqual([1]);
    expect(dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      'supportCase.DriverReply',
      expect.objectContaining({ email: 'admin@example.com', userId: 'usr_admin', language: 'de' }),
      expect.anything(),
      ALL_TEMPLATES_DIRS,
    );
  });

  it('picks the earliest active admin for an unassigned case', async () => {
    dbResults.push([ADMIN]);

    await dispatchOperatorNotification('new_case', 'case_2', 'SC-2', 'Help', null);

    expect(queries).toHaveLength(1);
    expect(dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      'supportCase.NewCaseFromDriver',
      expect.objectContaining({ userId: 'usr_admin', timezone: 'America/Chicago' }),
      expect.anything(),
      ALL_TEMPLATES_DIRS,
    );
  });

  it('sends nothing when no active admin exists', async () => {
    dbResults.push([]);

    await dispatchOperatorNotification('new_case', 'case_3', 'SC-3', 'Help', null);

    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });
});
