// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectRows, dbSelect, isAllSiteUser } = vi.hoisted(() => {
  const selectRows: { rows: unknown[] } = { rows: [] };
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectRows.rows).then(resolve);
  return {
    selectRows,
    dbSelect: vi.fn(() => chain),
    isAllSiteUser: vi.fn<(userId: string) => Promise<boolean>>(),
  };
});

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: dbSelect },
}));

vi.mock('../lib/site-access.js', () => ({
  isAllSiteUser,
  requireAllSiteAccess: vi.fn(),
}));

import { refuseSiteRestrictedFleetMembership } from '../lib/fleet-billing-access.js';

function makeReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      sent.status = code;
      return {
        send: (body: unknown) => {
          sent.body = body;
          return Promise.resolve();
        },
      };
    },
  };
  return { reply, sent };
}

const request = { user: { userId: 'usr_1' } };

describe('refuseSiteRestrictedFleetMembership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.rows = [];
  });

  it('lets an all-site user through without reading the fleet', async () => {
    isAllSiteUser.mockResolvedValue(true);
    const { reply, sent } = makeReply();
    expect(
      await refuseSiteRestrictedFleetMembership(request as never, reply as never, 'flt_1'),
    ).toBe(false);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(sent.status).toBeUndefined();
  });

  it('lets a restricted user change members of a fleet without pricing or account billing', async () => {
    isAllSiteUser.mockResolvedValue(false);
    selectRows.rows = [{ accountBillingEnabled: false, hasPricingGroup: false }];
    const { reply, sent } = makeReply();
    expect(
      await refuseSiteRestrictedFleetMembership(request as never, reply as never, 'flt_1'),
    ).toBe(false);
    expect(sent.status).toBeUndefined();
  });

  it.each([
    ['account billing', { accountBillingEnabled: true, hasPricingGroup: false }],
    ['a pricing group', { accountBillingEnabled: false, hasPricingGroup: true }],
  ])('answers 404 FLEET_NOT_FOUND to a restricted user for a fleet with %s', async (_, row) => {
    isAllSiteUser.mockResolvedValue(false);
    selectRows.rows = [row];
    const { reply, sent } = makeReply();
    expect(
      await refuseSiteRestrictedFleetMembership(request as never, reply as never, 'flt_1'),
    ).toBe(true);
    expect(sent).toEqual({
      status: 404,
      body: { error: 'Fleet not found', code: 'FLEET_NOT_FOUND' },
    });
  });

  it('answers the same 404 to a restricted user for a missing fleet', async () => {
    isAllSiteUser.mockResolvedValue(false);
    const { reply, sent } = makeReply();
    expect(
      await refuseSiteRestrictedFleetMembership(request as never, reply as never, 'flt_x'),
    ).toBe(true);
    expect(sent).toEqual({
      status: 404,
      body: { error: 'Fleet not found', code: 'FLEET_NOT_FOUND' },
    });
  });
});
