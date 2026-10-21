// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited query takes the next queued result.
let dbResults: unknown[] = [];
let dbCallIndex = 0;
type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const chains: { kind: string; chain: Chain }[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of ['from', 'where', 'set', 'returning', 'limit']) chain[m] = vi.fn(() => chain);
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    return Promise.resolve(r).then(resolve, reject);
  };
  chains.push({ kind, chain });
  return chain;
}

vi.mock('@evtivity/database', () => {
  const builders = {
    select: vi.fn(() => makeChain('select')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
  };
  return {
    db: {
      ...builders,
      transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(builders)),
    },
    drivers: { name: 'drivers' },
    vehicles: { name: 'vehicles' },
    chargingSessions: { name: 'charging_sessions' },
    driverNotificationPreferences: { name: 'driver_notification_preferences' },
    driverPushTokens: { name: 'driver_push_tokens' },
    mfaChallenges: { name: 'mfa_challenges' },
    userTokens: { name: 'user_tokens' },
    driverAuditLog: { name: 'driver_audit_log' },
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

const { eraseMethodsMock, deactivateMock, deleteCodesMock, deleteCredentialsMock } = vi.hoisted(
  () => ({
    eraseMethodsMock: vi.fn(),
    deactivateMock: vi.fn(),
    deleteCodesMock: vi.fn(),
    deleteCredentialsMock: vi.fn(),
  }),
);
vi.mock('../services/mfa-factor.service.js', () => ({
  deleteRecoveryCodes: deleteCodesMock,
  deleteWebauthnCredentials: deleteCredentialsMock,
}));
vi.mock('@evtivity/payments', () => ({ eraseDriverMethods: eraseMethodsMock }));
vi.mock('../lib/payments.js', () => ({ paymentContext: vi.fn(() => ({ ctx: true })) }));
vi.mock('../services/driver-status.service.js', () => ({
  applyDriverDeactivation: deactivateMock,
}));

import { writeAudit } from '@evtivity/database';
import { eraseDriver } from '../services/driver-erasure.service.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';

const DRIVER_ID = 'drv_000000000001';
const actor: AuditActorInfo = {
  actor: 'operator',
  actorUserId: 'usr_000000000001',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};
const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

function setFor(table: string): unknown {
  const update = chains.find((c) => c.kind === 'update')?.chain;
  void table;
  return update?.['set']?.mock.calls[0]?.[0];
}

describe('eraseDriver', () => {
  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    chains.length = 0;
    eraseMethodsMock.mockResolvedValue({ removed: 2 });
    deactivateMock.mockResolvedValue({ tokensDeactivated: 3 });
  });

  it('anonymizes the row, removes personal data, then methods and tokens, and audits counts only', async () => {
    // 1 driver, 2 active session check, 3 anonymize, 4 vehicles, 5-8 other deletes
    dbResults = [
      [{ id: DRIVER_ID, erasedAt: null }],
      [],
      [{ id: DRIVER_ID }],
      [{ id: 'veh_1' }],
      [],
      [],
      [],
      [],
    ];
    const result = await eraseDriver(DRIVER_ID, { actor, log });
    expect(result).toEqual({
      erasedAt: expect.any(Date),
      paymentMethodsRemoved: 2,
      vehiclesRemoved: 1,
      tokensDeactivated: 3,
    });
    expect(setFor('drivers')).toMatchObject({
      firstName: '',
      lastName: '',
      email: null,
      phone: null,
      passwordHash: null,
      totpSecretEnc: null,
      mfaEnabled: false,
      mfaMethod: null,
      isActive: false,
      billingName: null,
      billingStreet: null,
      billingCountry: null,
      erasedAt: expect.any(Date),
    });
    expect(chains.filter((c) => c.kind === 'delete')).toHaveLength(5);
    // The recovery codes go in the same transaction as the anonymized row.
    expect(deleteCodesMock).toHaveBeenCalledWith({ driverId: DRIVER_ID }, expect.anything());
    expect(deleteCredentialsMock).toHaveBeenCalledWith({ driverId: DRIVER_ID }, expect.anything());
    expect(eraseMethodsMock).toHaveBeenCalledWith(DRIVER_ID, { ctx: true });
    expect(deactivateMock).toHaveBeenCalledWith(DRIVER_ID, { actor, log });
    // The audit row holds counts only, never the erased data.
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'erased',
        before: null,
        after: { erased: true, paymentMethodsRemoved: 2, vehiclesRemoved: 1, tokensDeactivated: 3 },
      }),
      expect.anything(),
      log,
    );
  });

  it('runs the methods and token steps after the row is anonymized', async () => {
    dbResults = [[{ id: DRIVER_ID, erasedAt: null }], [], [{ id: DRIVER_ID }]];
    const order: string[] = [];
    eraseMethodsMock.mockImplementation(() => {
      order.push(
        `methods after ${String(chains.filter((c) => c.kind === 'update').length)} updates`,
      );
      return Promise.resolve({ removed: 0 });
    });
    await eraseDriver(DRIVER_ID, { actor, log });
    expect(order).toEqual(['methods after 1 updates']);
  });

  it('answers 404 for an unknown driver', async () => {
    dbResults = [[]];
    await expect(eraseDriver(DRIVER_ID, { actor, log })).rejects.toMatchObject({
      statusCode: 404,
      code: 'DRIVER_NOT_FOUND',
    });
  });

  it('answers 409 DRIVER_ERASED for a driver already erased', async () => {
    dbResults = [[{ id: DRIVER_ID, erasedAt: new Date() }]];
    await expect(eraseDriver(DRIVER_ID, { actor, log })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DRIVER_ERASED',
    });
    expect(eraseMethodsMock).not.toHaveBeenCalled();
  });

  it('answers 409 DRIVER_ERASED when a concurrent erasure won the guarded update', async () => {
    dbResults = [[{ id: DRIVER_ID, erasedAt: null }], [], []];
    await expect(eraseDriver(DRIVER_ID, { actor, log })).rejects.toMatchObject({
      code: 'DRIVER_ERASED',
    });
    expect(eraseMethodsMock).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('answers 409 DRIVER_HAS_ACTIVE_SESSION while the driver charges and changes nothing', async () => {
    dbResults = [[{ id: DRIVER_ID, erasedAt: null }], [{ id: 'ses_1' }]];
    await expect(eraseDriver(DRIVER_ID, { actor, log })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DRIVER_HAS_ACTIVE_SESSION',
    });
    expect(chains.filter((c) => c.kind === 'update')).toHaveLength(0);
  });
});
