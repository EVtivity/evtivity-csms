// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';

// Rows the next `db.select(...)` chain resolves to, in order.
const selectRows = vi.hoisted(() => ({ queue: [] as unknown[][], executed: [] as unknown[][] }));

vi.mock('@evtivity/database', () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    chain['from'] = () => chain;
    chain['innerJoin'] = () => chain;
    chain['where'] = () => Promise.resolve(selectRows.queue.shift() ?? []);
    return chain;
  };
  return {
    db: { select, execute: () => Promise.resolve(selectRows.executed.shift() ?? []) },
    chargingStations: {},
    stationConfigurations: {},
    circuits: {},
    panels: {},
    siteLoadManagement: {},
  };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

import {
  PLAN_TX_PROFILE_ID_MIN,
  assertNotLoadManaged,
  assertNotPlanProfileId,
  plannedProfileIdConflict,
  isPlannedConnectorSession,
  isPlannedTransaction,
  plannedClearConflict,
  txProfileConnectorWithoutTransaction,
  txProfileTransactionId,
  assertProfileIdAllowed,
  isReservedProfileId,
  mayOverrideLoadManagement,
  overridesLoadManagement,
  profileIdentityFromRequest,
} from '../lib/charging-profile-id.js';

describe('charging profile id against MaxExternalConstraintsId (K01.FR.81)', () => {
  it('reserves ids at or below the station value', () => {
    expect(isReservedProfileId(5000, 5000)).toBe(true);
    expect(isReservedProfileId(4999, 5000)).toBe(true);
    expect(isReservedProfileId(5001, 5000)).toBe(false);
  });

  it('checks nothing for a station without a recorded value', () => {
    expect(isReservedProfileId(1, null)).toBe(false);
    expect(() => {
      assertProfileIdAllowed(1, undefined);
    }).not.toThrow();
  });

  it('refuses a reserved id with 400 CHARGING_PROFILE_ID_RESERVED', () => {
    expect(() => {
      assertProfileIdAllowed(10, 5000);
    }).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: 'CHARGING_PROFILE_ID_RESERVED',
      }) as Error,
    );
  });
});

describe('profiles that would override load management', () => {
  const stationMax = (stackLevel: number, profileId = 100) => ({
    profileId,
    purpose: 'ChargingStationMaxProfile',
    stackLevel,
  });

  it('reads 2.1 and 1.6 SetChargingProfile requests', () => {
    expect(
      profileIdentityFromRequest({
        evseId: 0,
        chargingProfile: { id: 5, chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 2 },
      }),
    ).toEqual({ profileId: 5, purpose: 'TxDefaultProfile', stackLevel: 2 });
    expect(
      profileIdentityFromRequest({
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: 6,
          chargingProfilePurpose: 'ChargePointMaxProfile',
          stackLevel: 1,
        },
      }),
    ).toEqual({ profileId: 6, purpose: 'ChargePointMaxProfile', stackLevel: 1 });
    expect(profileIdentityFromRequest({})).toEqual({
      profileId: null,
      purpose: null,
      stackLevel: null,
    });
  });

  it('flags a station max profile at stack level 1 or above, and the load management id', () => {
    expect(overridesLoadManagement(stationMax(1), null)).toBe(true);
    expect(
      overridesLoadManagement(
        { profileId: 9, purpose: 'ChargePointMaxProfile', stackLevel: 3 },
        null,
      ),
    ).toBe(true);
    expect(overridesLoadManagement(stationMax(0), null)).toBe(false);
    expect(
      overridesLoadManagement({ profileId: 9, purpose: 'TxDefaultProfile', stackLevel: 5 }, null),
    ).toBe(false);
    // The load management id replaces the profile, whatever its purpose.
    expect(
      overridesLoadManagement(
        { profileId: 1_000_000_000, purpose: 'TxDefaultProfile', stackLevel: 0 },
        null,
      ),
    ).toBe(true);
    // The credit profile id (security case 334) is the station's too.
    expect(
      overridesLoadManagement(
        { profileId: 1_000_000_001, purpose: 'TxDefaultProfile', stackLevel: 0 },
        null,
      ),
    ).toBe(true);
    expect(overridesLoadManagement(stationMax(0, 2_000_000_002), 2_000_000_000)).toBe(true);
    // Above a high MaxExternalConstraintsId the load management id moves up.
    expect(overridesLoadManagement(stationMax(0, 2_000_000_001), 2_000_000_000)).toBe(true);
    expect(overridesLoadManagement(stationMax(0, 1_000_000_000), 2_000_000_000)).toBe(false);
  });

  it('reads the database only for a profile that could override load management', () => {
    expect(mayOverrideLoadManagement(stationMax(0))).toBe(false);
    expect(mayOverrideLoadManagement(stationMax(1))).toBe(true);
    expect(mayOverrideLoadManagement(stationMax(0, 1_500_000_000))).toBe(true);
  });

  it('refuses it with 400 CHARGING_PROFILE_LOAD_MANAGED on a managed station', async () => {
    selectRows.queue = [[{ id: 'sta_1' }]];
    await expect(assertNotLoadManaged({ dbId: 'sta_1' }, stationMax(1), null)).rejects.toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: 'CHARGING_PROFILE_LOAD_MANAGED',
      }) as Error,
    );
  });

  it('accepts it on a station load management does not manage', async () => {
    selectRows.queue = [[]];
    await expect(
      assertNotLoadManaged({ dbId: 'sta_1' }, stationMax(1), null),
    ).resolves.toBeUndefined();
  });

  it('looks a station up by its OCPP identity', async () => {
    selectRows.queue = [[{ id: 'sta_1' }], [{ id: 'sta_1' }]];
    await expect(assertNotLoadManaged({ identity: 'CS-1' }, stationMax(2), null)).rejects.toThrow(
      expect.objectContaining({ code: 'CHARGING_PROFILE_LOAD_MANAGED' }) as Error,
    );
  });

  it('accepts a stack level 0 station max profile without reading the database', async () => {
    selectRows.queue = [[{ id: 'sta_1' }]];
    await expect(
      assertNotLoadManaged({ dbId: 'sta_1' }, stationMax(0), null),
    ).resolves.toBeUndefined();
    expect(selectRows.queue).toHaveLength(1);
  });
});

describe('manual TxProfiles on a session the depot plan charges', () => {
  const txProfile = (transactionId: unknown) => ({
    evseId: 1,
    chargingProfile: { id: 5, chargingProfilePurpose: 'TxProfile', stackLevel: 1, transactionId },
  });

  it('reads the transaction of a 2.1 or 1.6 TxProfile only', () => {
    expect(txProfileTransactionId(txProfile('tx-1'))).toBe('tx-1');
    expect(
      txProfileTransactionId({
        connectorId: 1,
        csChargingProfiles: { chargingProfilePurpose: 'TxProfile', transactionId: 42 },
      }),
    ).toBe('42');
    expect(
      txProfileTransactionId({
        chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile', transactionId: 'tx-1' },
      }),
    ).toBeNull();
    expect(txProfileTransactionId(txProfile(undefined))).toBeNull();
  });

  it('finds the active session of the transaction in the depot plan', async () => {
    selectRows.executed = [[{ planned: 1 }], []];
    expect(await isPlannedTransaction('DEPOT-01', 'tx-1')).toBe(true);
    expect(await isPlannedTransaction('DEPOT-01', 'tx-2')).toBe(false);
  });

  it('reads the connector of a 1.6 TxProfile sent without a transaction', () => {
    const v16 = (profile: Record<string, unknown>, connectorId: unknown = 1) => ({
      connectorId,
      csChargingProfiles: { chargingProfileId: 5, stackLevel: 1, ...profile },
    });
    expect(txProfileConnectorWithoutTransaction(v16({ chargingProfilePurpose: 'TxProfile' }))).toBe(
      1,
    );
    expect(
      txProfileConnectorWithoutTransaction(
        v16({ chargingProfilePurpose: 'TxProfile', transactionId: 42 }),
      ),
    ).toBeNull();
    expect(
      txProfileConnectorWithoutTransaction(v16({ chargingProfilePurpose: 'TxProfile' }, 0)),
    ).toBeNull();
    expect(
      txProfileConnectorWithoutTransaction(v16({ chargingProfilePurpose: 'TxDefaultProfile' })),
    ).toBeNull();
    expect(txProfileConnectorWithoutTransaction(txProfile(undefined))).toBeNull();
  });

  it('finds the planned active session on a connector', async () => {
    selectRows.executed = [[{ planned: 1 }], []];
    expect(await isPlannedConnectorSession('DEPOT-01', 1)).toBe(true);
    expect(await isPlannedConnectorSession('DEPOT-01', 2)).toBe(false);
  });
});

describe('manual clears of the plan TxProfile of a planned session (case 317)', () => {
  const planned = [{ transaction_id: 'tx-1', evse_id: 1 }];
  const conflict = async (payload: Record<string, unknown>, rows: unknown[] = planned) => {
    selectRows.executed = [rows];
    return plannedClearConflict('DEPOT-01', payload);
  };

  it('finds a clear by the plan profile id, by TxProfile or by the EVSE', async () => {
    const planId = chargingNeedsProfileId('DEPOT-01', 'tx-1');
    expect(await conflict({ chargingProfileId: planId })).toBe('tx-1');
    expect(
      await conflict({ chargingProfileCriteria: { chargingProfilePurpose: 'TxProfile' } }),
    ).toBe('tx-1');
    expect(await conflict({ chargingProfileCriteria: { evseId: 1 } })).toBe('tx-1');
    // OCPP 1.6 form: id and connectorId.
    expect(await conflict({ id: planId })).toBe('tx-1');
    expect(await conflict({ connectorId: 1, chargingProfilePurpose: 'TxProfile' })).toBe('tx-1');
    expect(await conflict({})).toBe('tx-1');
  });

  it('passes a clear that cannot reach the plan profile', async () => {
    const planId = chargingNeedsProfileId('DEPOT-01', 'tx-1');
    expect(await conflict({ chargingProfileId: planId + 1 })).toBeNull();
    expect(await conflict({ chargingProfileCriteria: { evseId: 2 } })).toBeNull();
    expect(await conflict({ connectorId: 2, chargingProfilePurpose: 'TxProfile' })).toBeNull();
    expect(await conflict({ chargingProfileCriteria: { evseId: 1 } }, [])).toBeNull();
  });

  it('reads no database for another purpose or the station EVSE', async () => {
    selectRows.executed = [planned];
    expect(
      await plannedClearConflict('DEPOT-01', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile' },
      }),
    ).toBeNull();
    expect(await plannedClearConflict('DEPOT-01', { connectorId: 0 })).toBeNull();
    // The queued rows were not read.
    expect(selectRows.executed).toHaveLength(1);
    selectRows.executed = [];
  });
});

describe('manual profiles with the plan TxProfile id (OCPP-L1)', () => {
  const planned = [{ transaction_id: 'tx-1', evse_id: 1 }];

  it('finds a profile of any purpose with a planned session TxProfile id', async () => {
    const planId = chargingNeedsProfileId('DEPOT-01', 'tx-1');
    expect(planId).toBeGreaterThanOrEqual(PLAN_TX_PROFILE_ID_MIN);
    selectRows.executed = [planned];
    expect(await plannedProfileIdConflict('DEPOT-01', planId)).toBe('tx-1');
    selectRows.executed = [planned];
    expect(await plannedProfileIdConflict('DEPOT-01', planId + 1)).toBeNull();
    selectRows.executed = [planned];
    await expect(assertNotPlanProfileId('DEPOT-01', planId)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CHARGING_PROFILE_LOAD_MANAGED',
    });
    selectRows.executed = [];
  });

  it('reads no database for an id below the plan range or no id', async () => {
    selectRows.executed = [planned];
    expect(await plannedProfileIdConflict('DEPOT-01', 100)).toBeNull();
    expect(await plannedProfileIdConflict('DEPOT-01', null)).toBeNull();
    await assertNotPlanProfileId('DEPOT-01', 100);
    expect(selectRows.executed).toHaveLength(1);
    selectRows.executed = [];
  });
});
