// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { factorFlags, notifySecurityChange, sendSecurityNotice } from '../lib/security-notice.js';

const { rows, dispatchSystemNotification } = vi.hoisted(() => ({
  rows: { value: [] as unknown[] },
  dispatchSystemNotification: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => Promise.resolve(rows.value)),
  };
  return {
    db: chain,
    client: {},
    users: { id: 'users.id' },
    drivers: { id: 'drivers.id' },
  };
});

vi.mock('@evtivity/lib', () => ({
  dispatchSystemNotification: (...args: unknown[]) =>
    dispatchSystemNotification(...args) as unknown,
}));

vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['/t'] }));

const operator = {
  email: 'op@example.com',
  phone: '+12015550177',
  firstName: 'Ada',
  lastName: 'Lovelace',
  language: 'de',
  timezone: 'Europe/Berlin',
  mfaEnabled: true,
  mfaMethod: 'totp',
};

beforeEach(() => {
  dispatchSystemNotification.mockReset();
  dispatchSystemNotification.mockResolvedValue({ delivered: [] });
  rows.value = [operator];
});

describe('notifySecurityChange', () => {
  it('emails the operator once, without a userId so the SMS opt-out does not apply', async () => {
    await notifySecurityChange({ userId: 'usr_1' }, 'security.FactorAdded', {
      mfaTurnedOn: true,
      ...factorFlags('passkey'),
    });
    expect(dispatchSystemNotification).toHaveBeenCalledTimes(1);
    const [, eventType, recipient, variables] = dispatchSystemNotification.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(eventType).toBe('security.FactorAdded');
    expect(recipient).toEqual({
      email: 'op@example.com',
      phone: undefined,
      firstName: 'Ada',
      lastName: 'Lovelace',
      language: 'de',
      timezone: 'Europe/Berlin',
    });
    expect(variables).toMatchObject({ isDriver: false, mfaTurnedOn: true, factorPasskey: true });
  });

  it('texts the account number only while the account signs in with SMS codes', async () => {
    rows.value = [{ ...operator, mfaMethod: 'sms' }];
    await notifySecurityChange({ driverId: 'drv_1' }, 'security.RecoveryCodeUsed', {
      remaining: '3',
    });
    const [, , recipient, variables] = dispatchSystemNotification.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(recipient['phone']).toBe('+12015550177');
    expect(variables['isDriver']).toBe(true);
  });

  it('sends to the previous address and number it is given', async () => {
    await notifySecurityChange(
      { userId: 'usr_1' },
      'security.EmailChanged',
      {},
      {
        email: 'old@example.com',
        phone: '+12015550100',
      },
    );
    const [, , recipient] = dispatchSystemNotification.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(recipient['email']).toBe('old@example.com');
    expect(recipient['phone']).toBe('+12015550100');
  });

  it('texts the account number after SMS sign-in ended when asked', async () => {
    rows.value = [{ ...operator, mfaEnabled: false, mfaMethod: null }];
    await notifySecurityChange(
      { userId: 'usr_1' },
      'security.FactorRemoved',
      { mfaTurnedOff: true, byAdmin: true },
      { textAccountPhone: true },
    );
    const [, , recipient] = dispatchSystemNotification.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(recipient['phone']).toBe('+12015550177');
  });

  it('sends nothing for an unknown account', async () => {
    rows.value = [];
    expect(await notifySecurityChange({ userId: 'usr_x' }, 'security.FactorAdded', {})).toBeNull();
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });
});

describe('sendSecurityNotice', () => {
  it('fails open: logs a failed notice at warn', async () => {
    dispatchSystemNotification.mockRejectedValue(new Error('smtp down'));
    const log = { warn: vi.fn() };
    sendSecurityNotice({ userId: 'usr_1' }, 'security.ApiKeyCreated', { keyName: 'k' }, log);
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledTimes(1);
    });
  });
});
