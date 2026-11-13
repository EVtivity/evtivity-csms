// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { results, replies, awaitPubSubReply, publishOcppCommand, writeAudit, getUserSiteIds } =
  vi.hoisted(() => {
    const replies: unknown[] = [];
    return {
      results: [] as unknown[][],
      replies,
      publishOcppCommand: vi.fn().mockResolvedValue(undefined),
      awaitPubSubReply: vi.fn(async (_pubsub: unknown, opts: { send: () => Promise<void> }) => {
        await opts.send();
        return replies.shift() ?? null;
      }),
      writeAudit: vi.fn().mockResolvedValue(undefined),
      getUserSiteIds: vi.fn(),
    };
  });

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  awaitPubSubReply,
  publishOcppCommand,
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: vi.fn(), subscribe: vi.fn() })),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

vi.mock('@evtivity/ocpp', () => ({
  ActionRegistry: {
    Reset: { validateRequest: vi.fn().mockReturnValue(true) },
    DataTransfer: { validateRequest: vi.fn().mockReturnValue(true) },
    ClearTariffs: { validateRequest: vi.fn().mockReturnValue(true) },
    GetVariables: { validateRequest: vi.fn().mockReturnValue(true) },
    GetLocalListVersion: { validateRequest: vi.fn().mockReturnValue(true) },
    SetChargingProfile: { validateRequest: vi.fn().mockReturnValue(true) },
    ClearChargingProfile: { validateRequest: vi.fn().mockReturnValue(true) },
  },
  ActionRegistry16: {
    Reset: { validateRequest: vi.fn().mockReturnValue(true) },
    GetLocalListVersion: { validateRequest: vi.fn().mockReturnValue(true) },
    SetChargingProfile: { validateRequest: vi.fn().mockReturnValue(true) },
    ClearChargingProfile: { validateRequest: vi.fn().mockReturnValue(true) },
  },
}));

// The database reads behind the profile checks have their own tests
// (charging-profile-id.test.ts); the messages and pure checks stay real.
vi.mock('../lib/charging-profile-id.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/charging-profile-id.js')>()),
  maxExternalConstraintsIdByIdentity: vi.fn(async () => null),
  isLoadManagedStationIdentity: vi.fn(async () => false),
  plannedProfileIdConflict: vi.fn(async () => null),
  isPlannedTransaction: vi.fn(async () => false),
  isPlannedConnectorSession: vi.fn(async () => false),
  plannedClearConflict: vi.fn(async () => null),
}));

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds }));

vi.mock('@evtivity/database', () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
    let p: Promise<unknown> | null = null;
    chain['then'] = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) => {
      p ??= Promise.resolve(results.shift() ?? []);
      return p.then(onFulfilled, onRejected);
    };
    return chain;
  }
  return {
    db: { select: vi.fn(() => makeChain()) },
    chargingStations: { id: 'id', siteId: 'siteId', stationId: 'stationId' },
    stationConfigurations: {},
    stationAuditLog: { name: 'stationAuditLog' },
    localAuthListAuditLog: { name: 'localAuthListAuditLog' },
    writeAudit,
  };
});

import { registerAuth } from '../plugins/auth.js';
import { ocppCommandRoutes } from '../routes/ocpp-commands.js';

const station21 = { id: 'sta_internal', siteId: 'sit_a', ocppProtocol: 'ocpp2.1' };

import {
  isLoadManagedStationIdentity,
  isPlannedConnectorSession,
  isPlannedTransaction,
  maxExternalConstraintsIdByIdentity,
  plannedClearConflict,
  plannedProfileIdConflict,
} from '../lib/charging-profile-id.js';

const station16 = { ...station21, ocppProtocol: 'ocpp1.6' };

const schedule21 = [
  { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 1000 }] },
];

function profile21(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stationId: 'CS-1',
    evseId: 0,
    chargingProfile: {
      id: 5,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: schedule21,
      ...over,
    },
  };
}

function profile16(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stationId: 'CS-1',
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: 5,
      stackLevel: 0,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 1000 }],
      },
      ...over,
    },
  };
}

describe('OCPP command dispatch - charging profile guards', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    ocppCommandRoutes(app);
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    results.length = 0;
    replies.length = 0;
    getUserSiteIds.mockResolvedValue(null);
    writeAudit.mockResolvedValue(undefined);
    vi.mocked(maxExternalConstraintsIdByIdentity).mockResolvedValue(null);
    vi.mocked(isLoadManagedStationIdentity).mockResolvedValue(false);
    vi.mocked(plannedProfileIdConflict).mockResolvedValue(null);
    vi.mocked(isPlannedTransaction).mockResolvedValue(false);
    vi.mocked(isPlannedConnectorSession).mockResolvedValue(false);
    vi.mocked(plannedClearConflict).mockResolvedValue(null);
  });

  function post(url: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url, headers, payload });
  }

  it('refuses a 2.1 profile id at or below the station MaxExternalConstraintsId', async () => {
    vi.mocked(maxExternalConstraintsIdByIdentity).mockResolvedValue(10);
    results.push([station21]);
    const res = await post('/ocpp/commands/v21/SetChargingProfile', profile21());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'CHARGING_PROFILE_ID_RESERVED',
      action: 'SetChargingProfile',
    });
    expect(maxExternalConstraintsIdByIdentity).toHaveBeenCalledWith('CS-1');
    expect(publishOcppCommand).not.toHaveBeenCalled();
  });

  it('sends a 2.1 profile above the reserved range', async () => {
    vi.mocked(maxExternalConstraintsIdByIdentity).mockResolvedValue(2);
    results.push([station21]);
    replies.push({ response: { status: 'Accepted' } });
    const res = await post('/ocpp/commands/v21/SetChargingProfile', profile21());
    expect(res.statusCode).toBe(200);
    expect(publishOcppCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SetChargingProfile' }),
    );
  });

  it('refuses a station max profile that would lift the load management limit', async () => {
    vi.mocked(maxExternalConstraintsIdByIdentity).mockResolvedValue(2);
    vi.mocked(isLoadManagedStationIdentity).mockResolvedValue(true);
    results.push([station21]);
    const res = await post(
      '/ocpp/commands/v21/SetChargingProfile',
      profile21({ chargingProfilePurpose: 'ChargingStationMaxProfile', stackLevel: 5 }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CHARGING_PROFILE_LOAD_MANAGED');
    // The id check read the limit once; the load check reuses it.
    expect(maxExternalConstraintsIdByIdentity).toHaveBeenCalledTimes(1);
    expect(isLoadManagedStationIdentity).toHaveBeenCalledWith('CS-1');
  });

  it('sends a station max profile to a station load management does not manage', async () => {
    results.push([station21]);
    replies.push({ response: { status: 'Accepted' } });
    const res = await post(
      '/ocpp/commands/v21/SetChargingProfile',
      profile21({ chargingProfilePurpose: 'ChargingStationMaxProfile', stackLevel: 5 }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('reads the 1.6 load management check without a MaxExternalConstraintsId', async () => {
    vi.mocked(isLoadManagedStationIdentity).mockResolvedValue(true);
    results.push([station16]);
    const res = await post(
      '/ocpp/commands/v16/SetChargingProfile',
      profile16({ chargingProfilePurpose: 'ChargePointMaxProfile', stackLevel: 3 }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CHARGING_PROFILE_LOAD_MANAGED');
    expect(maxExternalConstraintsIdByIdentity).not.toHaveBeenCalled();
  });

  it('refuses a profile with the TxProfile id of a planned session', async () => {
    vi.mocked(plannedProfileIdConflict).mockResolvedValue('tx-9');
    results.push([station21]);
    const res = await post('/ocpp/commands/v21/SetChargingProfile', profile21());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CHARGING_PROFILE_LOAD_MANAGED');
    expect(plannedProfileIdConflict).toHaveBeenCalledWith('CS-1', 5);
  });

  it('refuses a TxProfile for a transaction the depot plan charges', async () => {
    vi.mocked(isPlannedTransaction).mockResolvedValue(true);
    results.push([station21]);
    const res = await post(
      '/ocpp/commands/v21/SetChargingProfile',
      profile21({ chargingProfilePurpose: 'TxProfile', transactionId: 'tx-1' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CHARGING_PROFILE_LOAD_MANAGED');
    expect(isPlannedTransaction).toHaveBeenCalledWith('CS-1', 'tx-1');
  });

  it('refuses a 1.6 TxProfile without a transaction on a planned connector', async () => {
    vi.mocked(isPlannedConnectorSession).mockResolvedValue(true);
    results.push([station16]);
    const res = await post('/ocpp/commands/v16/SetChargingProfile', profile16());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CHARGING_PROFILE_LOAD_MANAGED');
    expect(isPlannedConnectorSession).toHaveBeenCalledWith('CS-1', 1);
    expect(publishOcppCommand).not.toHaveBeenCalled();
  });

  it('refuses a clear that could remove the plan TxProfile', async () => {
    vi.mocked(plannedClearConflict).mockResolvedValue('tx-3');
    results.push([station21]);
    const res = await post('/ocpp/commands/v21/ClearChargingProfile', {
      stationId: 'CS-1',
      chargingProfileCriteria: { chargingProfilePurpose: 'TxProfile' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'CHARGING_PROFILE_LOAD_MANAGED',
      action: 'ClearChargingProfile',
    });
    expect(publishOcppCommand).not.toHaveBeenCalled();
  });

  it('sends a clear that touches no plan profile', async () => {
    results.push([station21]);
    replies.push({ response: { status: 'Accepted' } });
    const res = await post('/ocpp/commands/v21/ClearChargingProfile', {
      stationId: 'CS-1',
      chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile' },
    });
    expect(res.statusCode).toBe(200);
    expect(plannedClearConflict).toHaveBeenCalledWith(
      'CS-1',
      expect.objectContaining({
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile' },
      }),
    );
  });

  it('audits a GetLocalListVersion reply without a version as a null list version', async () => {
    results.push([station21]);
    replies.push({ response: {} });
    const res = await post('/ocpp/commands/v21/GetLocalListVersion', { stationId: 'CS-1' });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(writeAudit).toHaveBeenCalledWith(
        { table: { name: 'localAuthListAuditLog' }, idColumn: 'station_id' },
        expect.objectContaining({ action: 'pulled', after: { listVersion: null } }),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
