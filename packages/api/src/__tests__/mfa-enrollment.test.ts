// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Required MFA (Settings > Security > MFA): who gets the enrollment JWT at
// sign-in, and when the setup and confirm routes accept it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const {
  selectRows,
  readMfaConfig,
  getUserSessionState,
  countRecoveryCodes,
  sessionGuard,
  passkeys,
} = vi.hoisted(() => ({
  passkeys: { count: 0 },
  selectRows: [] as unknown[][],
  readMfaConfig: vi.fn(),
  getUserSessionState: vi.fn(),
  countRecoveryCodes: vi.fn(),
  sessionGuard: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectRows.shift() ?? [])),
      })),
    })),
  },
  readMfaConfig,
  roles: { id: 'roles.id', name: 'roles.name' },
  users: { id: 'users.id', mfaEnabled: 'users.mfa_enabled', mfaMethod: 'users.mfa_method' },
}));
vi.mock('../lib/user-active.js', () => ({ getUserSessionState }));
vi.mock('../services/mfa-factor.service.js', () => ({
  countRecoveryCodes,
  mfaFactorCounts: async (account: unknown) => ({
    recoveryCodesRemaining: (await countRecoveryCodes(account)) as number,
    passkeyCount: passkeys.count,
  }),
}));
vi.mock('../middleware/rbac.js', () => ({ selfService: () => sessionGuard }));

import {
  availableMfaMethods,
  bearerToken,
  isMfaEnrollmentRequest,
  isMfaPolicyUnavailable,
  isMfaSetupUnavailable,
  mfaEnrollmentTokenRejection,
  mfaPolicyForRole,
  operatorMfaEnrollment,
  renewalMfaGate,
  requiredMfaEnrollment,
  selfServiceOrMfaEnrollment,
  sendMfaPolicyUnavailable,
  signMfaEnrollmentToken,
} from '../lib/mfa-enrollment.js';

const sign = vi.fn(() => 'enrollment-jwt');
const logError = vi.fn();
const logWarn = vi.fn();
const app = {
  jwt: { sign },
  log: { warn: logWarn, error: logError },
} as unknown as FastifyInstance;

const BASE = {
  emailEnabled: true,
  totpEnabled: true,
  smsEnabled: false,
  required: 'off' as 'off' | 'all' | 'roles',
  requiredRoles: [] as string[],
  webauthnEnabled: true,
  passkeyLoginEnabled: false,
  requireDrivers: false,
};
const read = (config: Partial<typeof BASE> & Record<string, unknown>, fallback = false) => ({
  config: { ...BASE, ...config },
  fallback,
});

const user = {
  id: 'usr_1',
  roleId: 'rol_admin',
  email: 'op@example.com',
  phone: null,
  sessionVersion: 4,
};

beforeEach(() => {
  selectRows.length = 0;
  readMfaConfig.mockResolvedValue(read({}));
  getUserSessionState.mockResolvedValue({ active: true, sessionVersion: 4 });
  countRecoveryCodes.mockResolvedValue(0);
});

describe('availableMfaMethods', () => {
  it('lists the switched-on methods the account has a contact for', () => {
    expect(availableMfaMethods({ ...BASE, smsEnabled: true }, user)).toEqual(['email', 'totp']);
    expect(
      availableMfaMethods({ ...BASE, smsEnabled: true }, { ...user, phone: '+12015550111' }),
    ).toEqual(['email', 'totp', 'sms']);
    expect(availableMfaMethods({ ...BASE, emailEnabled: false, totpEnabled: false }, user)).toEqual(
      [],
    );
  });
});

describe('signMfaEnrollmentToken', () => {
  it('signs a 10-minute token with the enrollment flag and the session version', () => {
    expect(signMfaEnrollmentToken(app, user)).toBe('enrollment-jwt');
    expect(sign).toHaveBeenCalledWith(
      { userId: 'usr_1', roleId: 'rol_admin', mfaEnrollment: true, sv: 4 },
      { expiresIn: '10m' },
    );
  });
});

describe('requiredMfaEnrollment', () => {
  it('requires nothing while required MFA is off', async () => {
    expect(await requiredMfaEnrollment(app, user)).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it('requires every operator with all', async () => {
    readMfaConfig.mockResolvedValue(read({ required: 'all' }));
    selectRows.push([{ name: 'viewer' }]);
    expect(await requiredMfaEnrollment(app, user)).toEqual({
      mfaEnrollmentRequired: true,
      enrollmentToken: 'enrollment-jwt',
      availableMethods: ['email', 'totp'],
      webauthnAvailable: true,
    });
  });

  it('requires a listed role and lets another role sign in', async () => {
    readMfaConfig.mockResolvedValue(read({ required: 'roles', requiredRoles: ['admin'] }));
    selectRows.push([{ name: 'admin' }]);
    expect(await requiredMfaEnrollment(app, user)).toMatchObject({ mfaEnrollmentRequired: true });

    selectRows.push([{ name: 'operator' }]);
    expect(await requiredMfaEnrollment(app, user)).toBeNull();
  });

  it('fails closed on a failed settings read: the sign-in is refused and logged', async () => {
    readMfaConfig.mockResolvedValue(read({}, true));
    const reply = await requiredMfaEnrollment(app, user);
    expect(reply).toEqual({ mfaPolicyUnavailable: true });
    expect(reply != null && isMfaPolicyUnavailable(reply)).toBe(true);
    expect(reply != null && isMfaSetupUnavailable(reply)).toBe(false);
    expect(sign).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      { userId: 'usr_1' },
      expect.stringContaining('could not be read'),
    );
  });

  it('refuses the sign-in and logs an error when no method can be set up', async () => {
    readMfaConfig.mockResolvedValue(
      read({ required: 'all', emailEnabled: false, totpEnabled: false, smsEnabled: true }),
    );
    selectRows.push([{ name: 'admin' }]);
    const reply = await requiredMfaEnrollment(app, user);
    expect(reply).toEqual({ mfaSetupUnavailable: true });
    expect(reply != null && isMfaSetupUnavailable(reply)).toBe(true);
    expect(sign).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      { userId: 'usr_1' },
      expect.stringContaining('sign-in refused'),
    );
  });

  it('keeps the D2 fallback: a switched-off only factor with nothing to set up signs in', () => {
    const config = { ...BASE, emailEnabled: false, totpEnabled: false };
    expect(operatorMfaEnrollment(app, user, config)).toBeNull();
    expect(logWarn).toHaveBeenCalled();
  });
});

describe('mfaPolicyForRole', () => {
  it('follows the setting for the user role', async () => {
    expect(await mfaPolicyForRole('rol_admin')).toBe('not_required');

    readMfaConfig.mockResolvedValue(read({ required: 'roles', requiredRoles: ['admin'] }));
    selectRows.push([{ name: 'admin' }]);
    expect(await mfaPolicyForRole('rol_admin')).toBe('required');

    selectRows.push([{ name: 'viewer' }]);
    expect(await mfaPolicyForRole('rol_viewer')).toBe('not_required');

    readMfaConfig.mockResolvedValue(read({ required: 'all' }));
    selectRows.push([{ name: 'viewer' }]);
    expect(await mfaPolicyForRole('rol_viewer')).toBe('required');
  });

  it('answers unavailable on a failed settings read, whatever the defaults say', async () => {
    readMfaConfig.mockResolvedValue(read({ required: 'off' }, true));
    expect(await mfaPolicyForRole('rol_admin')).toBe('unavailable');
  });
});

describe('sendMfaPolicyUnavailable', () => {
  it('logs at error and answers 503 MFA_POLICY_UNAVAILABLE', async () => {
    const error = vi.fn();
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    await sendMfaPolicyUnavailable(
      { log: { error } } as unknown as FastifyRequest,
      { status } as unknown as FastifyReply,
      'usr_1',
    );
    expect(error).toHaveBeenCalledWith({ userId: 'usr_1' }, expect.any(String));
    expect(status).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ code: 'MFA_POLICY_UNAVAILABLE' }));
  });
});

describe('renewalMfaGate', () => {
  const holder = { id: 'usr_1', roleId: 'rol_admin', mfaEnabled: false, mfaMethod: null };

  it('renews while required MFA is off', async () => {
    expect(await renewalMfaGate(holder)).toBe('renew');
  });

  it('asks a user without a factor whom required MFA covers to enroll', async () => {
    readMfaConfig.mockResolvedValue(read({ required: 'all' }));
    selectRows.push([{ name: 'admin' }]);
    expect(await renewalMfaGate(holder)).toBe('enrollment_required');
  });

  it('renews a user whose role required MFA does not cover', async () => {
    readMfaConfig.mockResolvedValue(read({ required: 'roles', requiredRoles: ['admin'] }));
    selectRows.push([{ name: 'viewer' }]);
    expect(await renewalMfaGate({ ...holder, roleId: 'rol_viewer' })).toBe('renew');
  });

  it('renews a user with a usable method, recovery codes or a passkey', async () => {
    readMfaConfig.mockResolvedValue(read({ required: 'all' }));
    expect(await renewalMfaGate({ ...holder, mfaEnabled: true, mfaMethod: 'totp' })).toBe('renew');
    countRecoveryCodes.mockResolvedValue(3);
    expect(await renewalMfaGate(holder)).toBe('renew');
    countRecoveryCodes.mockResolvedValue(0);
    passkeys.count = 1;
    try {
      expect(await renewalMfaGate(holder)).toBe('renew');
    } finally {
      passkeys.count = 0;
    }
  });

  it('asks to enroll when the only method is switched off and nothing else is left', async () => {
    readMfaConfig.mockResolvedValue(read({ required: 'all', totpEnabled: false }));
    selectRows.push([{ name: 'admin' }]);
    expect(await renewalMfaGate({ ...holder, mfaEnabled: true, mfaMethod: 'totp' })).toBe(
      'enrollment_required',
    );
  });

  it('fails closed on a failed settings read for a user without a factor only', async () => {
    readMfaConfig.mockResolvedValue(read({}, true));
    expect(await renewalMfaGate(holder)).toBe('policy_unavailable');
    expect(await renewalMfaGate({ ...holder, mfaEnabled: true, mfaMethod: 'email' })).toBe('renew');
  });
});

describe('mfaEnrollmentTokenRejection', () => {
  const payload = { userId: 'usr_1', roleId: 'rol_admin', mfaEnrollment: true, sv: 4 };

  it('accepts the token of an account without MFA', async () => {
    selectRows.push([{ mfaEnabled: false, mfaMethod: null }]);
    expect(await mfaEnrollmentTokenRejection(payload)).toBeNull();
  });

  it('accepts the token while the only method is switched off', async () => {
    readMfaConfig.mockResolvedValue(read({ emailEnabled: false }));
    selectRows.push([{ mfaEnabled: true, mfaMethod: 'email' }]);
    expect(await mfaEnrollmentTokenRejection(payload)).toBeNull();
  });

  it('refuses the token once MFA is set up, so it works once', async () => {
    selectRows.push([{ mfaEnabled: true, mfaMethod: 'totp' }]);
    expect(await mfaEnrollmentTokenRejection(payload)).toEqual({
      error: 'MFA is already set up',
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses the token while recovery codes are left', async () => {
    readMfaConfig.mockResolvedValue(read({ emailEnabled: false }));
    countRecoveryCodes.mockResolvedValue(2);
    selectRows.push([{ mfaEnabled: true, mfaMethod: 'email' }]);
    expect((await mfaEnrollmentTokenRejection(payload))?.code).toBe('UNAUTHORIZED');
  });

  it('refuses the token once a passkey is registered, and while passkeys are switched off accepts it', async () => {
    passkeys.count = 1;
    selectRows.push([{ mfaEnabled: false, mfaMethod: null }]);
    expect((await mfaEnrollmentTokenRejection(payload))?.code).toBe('UNAUTHORIZED');
    readMfaConfig.mockResolvedValue(read({ webauthnEnabled: false }));
    selectRows.push([{ mfaEnabled: false, mfaMethod: null }]);
    expect(await mfaEnrollmentTokenRejection(payload)).toBeNull();
    passkeys.count = 0;
  });

  it('refuses the token of another session version', async () => {
    getUserSessionState.mockResolvedValue({ active: true, sessionVersion: 5 });
    expect(await mfaEnrollmentTokenRejection(payload)).toEqual({
      error: 'Session ended',
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses the token of a deactivated user', async () => {
    getUserSessionState.mockResolvedValue({ active: false, sessionVersion: 4 });
    expect((await mfaEnrollmentTokenRejection(payload))?.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('refuses a driver enrollment token, even one that names a userId', async () => {
    const driverToken = { ...payload, driverId: 'drv_1', type: 'driver' };
    expect(await mfaEnrollmentTokenRejection(driverToken)).toEqual({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
    });
    expect(getUserSessionState).not.toHaveBeenCalled();
  });
});

describe('bearerToken', () => {
  function withHeader(authorization: string | undefined): FastifyRequest {
    return { headers: authorization == null ? {} : { authorization } } as FastifyRequest;
  }

  it('reads the token of a Bearer header only', () => {
    expect(bearerToken(withHeader('Bearer abc.def'))).toBe('abc.def');
    expect(bearerToken(withHeader('bearer abc'))).toBe('abc');
    expect(bearerToken(withHeader(undefined))).toBeNull();
    expect(bearerToken(withHeader(''))).toBeNull();
    expect(bearerToken(withHeader('Basic junk'))).toBeNull();
    expect(bearerToken(withHeader('x'))).toBeNull();
    expect(bearerToken(withHeader('Bearer '))).toBeNull();
  });
});

describe('selfServiceOrMfaEnrollment', () => {
  function makeRequest(authorization: string | undefined, verify: () => unknown) {
    return {
      headers: authorization != null ? { authorization } : {},
      server: { jwt: { verify } },
      log: { debug: vi.fn() },
    } as unknown as FastifyRequest;
  }
  function makeReply() {
    const reply = { status: vi.fn(), send: vi.fn() };
    reply.status.mockReturnValue(reply);
    return reply as unknown as FastifyReply & { status: typeof reply.status };
  }

  it('takes the enrollment token as the subject', async () => {
    selectRows.push([{ mfaEnabled: false, mfaMethod: null }]);
    const payload = { userId: 'usr_1', roleId: 'rol_admin', mfaEnrollment: true, sv: 4 };
    const request = makeRequest('Bearer enrollment-jwt', () => payload);
    const reply = makeReply();
    await selfServiceOrMfaEnrollment()(request, reply);
    expect(reply.status).not.toHaveBeenCalled();
    expect(sessionGuard).not.toHaveBeenCalled();
    expect(isMfaEnrollmentRequest(request)).toBe(true);
  });

  it('answers 401 for an enrollment token it refuses', async () => {
    getUserSessionState.mockResolvedValue({ active: true, sessionVersion: 9 });
    const payload = { userId: 'usr_1', roleId: 'rol_admin', mfaEnrollment: true, sv: 4 };
    const reply = makeReply();
    await selfServiceOrMfaEnrollment()(
      makeRequest('Bearer old-jwt', () => payload),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(sessionGuard).not.toHaveBeenCalled();
  });

  it('leaves a session JWT, an invalid token and a cookie session to the session guard', async () => {
    const reply = makeReply();
    await selfServiceOrMfaEnrollment()(
      makeRequest('Bearer session-jwt', () => ({ userId: 'usr_1', sv: 4 })),
      reply,
    );
    await selfServiceOrMfaEnrollment()(
      makeRequest('Bearer garbage', () => {
        throw new Error('bad signature');
      }),
      reply,
    );
    await selfServiceOrMfaEnrollment()(
      makeRequest(undefined, () => ({})),
      reply,
    );
    expect(sessionGuard).toHaveBeenCalledTimes(3);
  });
});
