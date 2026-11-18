// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Fleet driver notices are sent only while Fleets (fleet.enabled) is on, and a
// failed switch read counts as off.

const mockSendMail = vi.fn().mockResolvedValue({});
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: mockSendMail })) },
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) }));
vi.stubGlobal('fetch', vi.fn());

type FleetRow = 'on' | 'off' | 'missing' | 'error';
let fleetRow: FleetRow = 'on';
const texts: string[] = [];

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join('?');
    texts.push(text);
    if (text.includes("key = 'fleet.enabled'")) {
      if (fleetRow === 'error') return Promise.reject(new Error('connection lost'));
      if (fleetRow === 'missing') return Promise.resolve([]);
      return Promise.resolve([{ value: fleetRow === 'on' }]);
    }
    if (text.includes('FROM drivers WHERE id')) {
      return Promise.resolve([
        {
          first_name: 'Mia',
          last_name: 'Member',
          email: 'mia@example.com',
          phone: null,
          language: 'en',
          timezone: 'UTC',
        },
      ]);
    }
    if (text.includes("LIKE 'smtp.%'")) {
      return Promise.resolve([
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 'smtp.from', value: 'billing@example.com' },
      ]);
    }
    return Promise.resolve([]);
  };
  (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (value: unknown) => value;
  return sqlFn as unknown;
}

let dispatchModule: typeof import('../notification-dispatch.js');
beforeAll(async () => {
  dispatchModule = await import('../notification-dispatch.js');
}, 30_000);

function sent(): boolean {
  return mockSendMail.mock.calls.length > 0;
}

async function dispatch(eventType: string): Promise<void> {
  await dispatchModule.dispatchDriverNotification(
    createSqlMock() as Parameters<typeof dispatchModule.dispatchDriverNotification>[0],
    eventType,
    'drv_000000000001',
    {},
    [],
  );
}

describe('fleet driver notices and the Fleets switch', () => {
  beforeEach(() => {
    dispatchModule.clearNotificationSettingsCache();
    texts.length = 0;
    mockSendMail.mockClear();
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
  });

  it.each([
    'token.FleetCardAssigned',
    'token.FleetCardTakenBack',
    'token.MonthlyLimitReached',
    'invoice.MemberInvoice',
    'invoice.MemberOverdue',
    'fleet.AccountBillingChanged',
  ])('sends %s while Fleets is on', async (eventType) => {
    fleetRow = 'on';
    await dispatch(eventType);
    expect(sent()).toBe(true);
  });

  it.each(['token.FleetCardAssigned', 'token.MonthlyLimitReached', 'invoice.MemberInvoice'])(
    'sends nothing for %s while Fleets is off',
    async (eventType) => {
      fleetRow = 'off';
      await dispatch(eventType);
      expect(sent()).toBe(false);
      expect(texts.some((t) => t.includes('FROM drivers WHERE id'))).toBe(false);
    },
  );

  it('counts a missing setting row as on (the seeded default)', async () => {
    fleetRow = 'missing';
    await dispatch('token.FleetCardAssigned');
    expect(sent()).toBe(true);
  });

  it('sends nothing when the switch read fails and nothing is cached', async () => {
    fleetRow = 'error';
    await dispatch('invoice.MemberOverdue');
    expect(sent()).toBe(false);
    expect(await dispatchModule.isFleetOnForDriverNotices(createSqlMock() as never)).toBe(false);
  });

  it('keeps a cached on value when a later read fails', async () => {
    fleetRow = 'on';
    expect(await dispatchModule.isFleetOnForDriverNotices(createSqlMock() as never)).toBe(true);
    fleetRow = 'error';
    expect(await dispatchModule.isFleetOnForDriverNotices(createSqlMock() as never)).toBe(true);
  });

  it('never reads the switch for other driver notices', async () => {
    fleetRow = 'off';
    await dispatch('token.Added');
    expect(sent()).toBe(true);
    expect(texts.some((t) => t.includes("key = 'fleet.enabled'"))).toBe(false);
  });
});
