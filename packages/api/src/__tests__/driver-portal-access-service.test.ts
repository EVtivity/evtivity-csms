// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, dispatchMock, writeAuditMock, revokeRefreshMock } = vi.hoisted(() => ({
  state: {
    selectResults: [] as unknown[][],
    returningResults: [] as unknown[][],
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
  },
  dispatchMock: vi.fn(() => Promise.resolve(undefined)),
  writeAuditMock: vi.fn(() => Promise.resolve(undefined)),
  revokeRefreshMock: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('argon2', () => ({
  default: { hash: vi.fn((pw: string) => Promise.resolve(`hash(${pw})`)) },
}));
vi.mock('../lib/config.js', () => ({ config: { PORTAL_URL: 'https://portal.test' } }));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['templates'] }));
vi.mock('../services/refresh-token.service.js', () => ({
  revokeAllDriverRefreshTokens: revokeRefreshMock,
}));
vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dispatchSystemNotification: dispatchMock };
});

vi.mock('@evtivity/database', () => {
  const selectChain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit']) selectChain[m] = () => selectChain;
  selectChain['then'] = (resolve: (v: unknown) => void) => {
    resolve(state.selectResults.shift() ?? []);
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      state.updates.push(v);
      return updateChain;
    },
    where: () => ({
      returning: () => Promise.resolve(state.returningResults.shift() ?? []),
      then: (resolve: (v: unknown) => void) => {
        resolve(undefined);
      },
    }),
  };
  const db = {
    select: () => selectChain,
    update: () => updateChain,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserts.push(v);
        return Promise.resolve(undefined);
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return {
    db,
    client: {},
    drivers: {},
    userTokens: {},
    driverAuditLog: {},
    writeAudit: writeAuditMock,
  };
});

import {
  inviteDriverToPortal,
  activateDriverPortal,
  getPortalAccess,
} from '../services/driver-portal-access.service.js';

const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn: vi.fn() },
};

const driver = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'drv_1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: null,
  language: 'en',
  isActive: true,
  passwordHash: null,
  ...overrides,
});

const STRONG = 'Str0ng!Password';

beforeEach(() => {
  state.selectResults.length = 0;
  state.returningResults.length = 0;
  state.updates.length = 0;
  state.inserts.length = 0;
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
  writeAuditMock.mockClear();
  revokeRefreshMock.mockClear();
  ctx.log.warn.mockClear();
});

describe('inviteDriverToPortal', () => {
  it('rejects an unknown driver with DRIVER_NOT_FOUND', async () => {
    state.selectResults.push([]);
    await expect(inviteDriverToPortal('drv_x', ctx)).rejects.toMatchObject({
      statusCode: 404,
      code: 'DRIVER_NOT_FOUND',
    });
  });

  it('rejects an inactive driver with DRIVER_INACTIVE', async () => {
    state.selectResults.push([driver({ isActive: false })]);
    await expect(inviteDriverToPortal('drv_1', ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DRIVER_INACTIVE',
    });
  });

  it('rejects a driver without an email with EMAIL_REQUIRED', async () => {
    state.selectResults.push([driver({ email: null })]);
    await expect(inviteDriverToPortal('drv_1', ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'EMAIL_REQUIRED',
    });
  });

  it('rejects a driver who already has a password with PORTAL_ALREADY_ACTIVE', async () => {
    state.selectResults.push([driver({ passwordHash: 'h' })]);
    await expect(inviteDriverToPortal('drv_1', ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PORTAL_ALREADY_ACTIVE',
    });
    expect(state.inserts).toHaveLength(0);
  });

  it('revokes earlier invites, stores a 7-day token, emails the link, and audits', async () => {
    state.selectResults.push([driver()]);
    const before = Date.now();

    const { expiresAt } = await inviteDriverToPortal('drv_1', ctx);

    const days = (expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(state.updates[0]).toHaveProperty('revokedAt');
    expect(state.inserts[0]).toMatchObject({
      driverId: 'drv_1',
      type: 'portal_invite',
      expiresAt,
    });
    const tokenHash = state.inserts[0]?.['tokenHash'] as string;

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, eventType, recipient, vars] = dispatchMock.mock.calls[0] as unknown as [
      unknown,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(eventType).toBe('driver.PortalInvite');
    expect(recipient).toMatchObject({ email: 'jane@example.com', language: 'en' });
    expect(vars).toMatchObject({ firstName: 'Jane', lastName: 'Doe', expiresInDays: 7 });
    const url = new URL(vars['activateUrl'] as string);
    expect(url.origin + url.pathname).toBe('https://portal.test/activate');
    const raw = url.searchParams.get('token');
    expect(raw).toBeTruthy();
    expect(raw).not.toBe(tokenHash);

    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityId: 'drv_1', action: 'portal_invited', actor: 'operator' }),
      expect.anything(),
      ctx.log,
    );
  });

  it('still succeeds when the email dispatch fails, and logs a warning', async () => {
    state.selectResults.push([driver()]);
    dispatchMock.mockRejectedValueOnce(new Error('smtp down'));

    await expect(inviteDriverToPortal('drv_1', ctx)).resolves.toHaveProperty('expiresAt');
    expect(ctx.log.warn).toHaveBeenCalled();
    expect(writeAuditMock).toHaveBeenCalled();
  });
});

describe('activateDriverPortal', () => {
  it('rejects a weak password with WEAK_PASSWORD before touching the token', async () => {
    await expect(activateDriverPortal('raw', 'short', ctx.log)).rejects.toMatchObject({
      statusCode: 400,
      code: 'WEAK_PASSWORD',
    });
    expect(state.updates).toHaveLength(0);
  });

  it('rejects an unknown, used, revoked, or expired token with INVALID_TOKEN', async () => {
    state.returningResults.push([]);
    await expect(activateDriverPortal('raw', STRONG, ctx.log)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_TOKEN',
    });
    expect(revokeRefreshMock).not.toHaveBeenCalled();
  });

  it('rejects with INVALID_TOKEN when the driver is inactive or already has a password', async () => {
    state.returningResults.push([{ driverId: 'drv_1' }], []);
    await expect(activateDriverPortal('raw', STRONG, ctx.log)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_TOKEN',
    });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('sets the password, verifies the email, revokes the other invites, and audits', async () => {
    state.returningResults.push([{ driverId: 'drv_1' }], [{ id: 'drv_1' }]);

    await activateDriverPortal('raw', STRONG, ctx.log);

    expect(state.updates[0]).toHaveProperty('revokedAt');
    expect(state.updates[1]).toMatchObject({
      passwordHash: `hash(${STRONG})`,
      emailVerified: true,
    });
    expect(state.updates[2]).toHaveProperty('revokedAt');
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityId: 'drv_1',
        action: 'portal_activated',
        actor: 'driver',
        actorDriverId: 'drv_1',
      }),
      expect.anything(),
      ctx.log,
    );
    expect(revokeRefreshMock).toHaveBeenCalledWith('drv_1');
  });
});

describe('getPortalAccess', () => {
  it('reports active when the driver has a password', async () => {
    state.selectResults.push([{ passwordHash: 'h' }]);
    await expect(getPortalAccess('drv_1')).resolves.toEqual({
      status: 'active',
      inviteExpiresAt: null,
    });
  });

  it('reports invited with the open invite expiry', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    state.selectResults.push([{ passwordHash: null }], [{ expiresAt }]);
    await expect(getPortalAccess('drv_1')).resolves.toEqual({
      status: 'invited',
      inviteExpiresAt: expiresAt,
    });
  });

  it('reports none without a password or open invite', async () => {
    state.selectResults.push([{ passwordHash: null }], []);
    await expect(getPortalAccess('drv_1')).resolves.toEqual({
      status: 'none',
      inviteExpiresAt: null,
    });
  });
});
