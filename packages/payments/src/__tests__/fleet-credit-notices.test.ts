// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  contacts: vi.fn(),
  operators: [] as Record<string, unknown>[],
  dispatchSystemNotification: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  client: (): Promise<unknown[]> => Promise.resolve(h.operators),
  claimFleetCreditLimitNotice: h.claim,
  loadFleetBillingContacts: h.contacts,
}));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchSystemNotification: h.dispatchSystemNotification,
}));

import type { FleetCreditCheck } from '@evtivity/database';
import {
  dispatchFleetCreditLimitNotices,
  FLEET_CREDIT_LIMIT_REACHED_EVENT,
  FLEET_CREDIT_LIMIT_WARNING_EVENT,
} from '../fleet-credit-notices.js';

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
const deps = { templatesDirs: ['/t'] };

function check(level: FleetCreditCheck['level'], totalCents = 8000): FleetCreditCheck {
  return {
    fleetId: 'flt_1',
    fleetName: 'Acme',
    limitCents: 10_000,
    warningPercent: 80,
    exposure: {
      unbilledCents: totalCents,
      invoicedCents: 0,
      runningCents: 0,
      totalCents,
      currency: 'EUR',
    },
    level,
    remainingCents: Math.max(10_000 - totalCents, 0),
    ceilingCents: null,
  };
}

const operator = {
  id: 'usr_1',
  email: 'ops@example.com',
  phone: null,
  first_name: 'Ops',
  last_name: 'User',
  language: 'de',
  timezone: 'Europe/Berlin',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.claim.mockResolvedValue(true);
  h.contacts.mockResolvedValue({ emails: [], language: 'en' });
  h.operators = [operator];
  h.dispatchSystemNotification.mockResolvedValue(undefined);
});

describe('dispatchFleetCreditLimitNotices', () => {
  it('sends nothing below the warning percent', async () => {
    expect(await dispatchFleetCreditLimitNotices(check('ok', 1000), deps, log)).toBeNull();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('warns the billing contacts in the fleet invoice language once the claim is won', async () => {
    h.contacts.mockResolvedValue({ emails: ['billing@acme.example'], language: 'de' });
    expect(await dispatchFleetCreditLimitNotices(check('warning'), deps, log)).toBe('warning');
    expect(h.claim).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'warning');
    expect(h.dispatchSystemNotification).toHaveBeenCalledTimes(1);
    const [, eventType, recipient, variables, dirs] = h.dispatchSystemNotification.mock
      .calls[0] as [unknown, string, { email: string }, Record<string, unknown>, string[]];
    expect(eventType).toBe(FLEET_CREDIT_LIMIT_WARNING_EVENT);
    expect(recipient).toEqual({ email: 'billing@acme.example', language: 'de' });
    expect(h.contacts).toHaveBeenCalledWith(expect.anything(), 'flt_1');
    expect(variables).toMatchObject({
      fleetName: 'Acme',
      limitCents: 10_000,
      exposureCents: 8000,
      warningPercent: 80,
      currency: 'EUR',
    });
    expect(dirs).toEqual(['/t']);
  });

  it('warns the fleet operators when the fleet has no billing contact', async () => {
    await dispatchFleetCreditLimitNotices(check('warning'), deps, log);
    const recipient = h.dispatchSystemNotification.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(recipient).toMatchObject({
      email: 'ops@example.com',
      language: 'de',
      timezone: 'Europe/Berlin',
      userId: 'usr_1',
    });
  });

  it('sends the reached notice to the contacts and the operators, each address once', async () => {
    h.contacts.mockResolvedValue({
      emails: ['billing@acme.example', 'OPS@example.com'],
      language: 'en',
    });
    expect(await dispatchFleetCreditLimitNotices(check('reached', 10_000), deps, log)).toBe(
      'reached',
    );
    expect(h.claim).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'reached');
    const emails = h.dispatchSystemNotification.mock.calls.map(
      (c) => (c[2] as { email: string }).email,
    );
    expect(emails).toEqual(['billing@acme.example', 'OPS@example.com']);
    expect(h.dispatchSystemNotification.mock.calls[0]?.[1]).toBe(FLEET_CREDIT_LIMIT_REACHED_EVENT);
  });

  it('sends nothing when the notice went out this month already', async () => {
    h.claim.mockResolvedValue(false);
    expect(await dispatchFleetCreditLimitNotices(check('reached', 10_000), deps, log)).toBeNull();
    expect(h.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('logs a missing recipient at warn', async () => {
    h.operators = [];
    expect(await dispatchFleetCreditLimitNotices(check('warning'), deps, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      { fleetId: 'flt_1', kind: 'warning' },
      'No recipient for the fleet credit limit notice',
    );
  });

  it('is fail-open', async () => {
    h.claim.mockRejectedValue(new Error('db down'));
    expect(await dispatchFleetCreditLimitNotices(check('reached', 10_000), deps, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fleetId: 'flt_1', kind: 'reached' }),
      'Fleet credit limit notice failed; continuing',
    );
  });
});
