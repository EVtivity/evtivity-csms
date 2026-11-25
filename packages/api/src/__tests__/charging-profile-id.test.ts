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
  plannedProfileIdConflict,
  isPlannedConnectorSession,
  isPlannedTransaction,
  isEvseManagedConnectorSession,
  isEvseManagedTransaction,
  plannedClearConflict,
  evseManagedClearConflict,
  txProfileConnectorWithoutTransaction,
  txProfileTransactionId,
  assertProfileIdAllowed,
  isReservedProfileId,
  mayOverrideLoadManagement,
  overridesLoadManagement,
  profileIdentityFromRequest,
  clearRemovesLoadManagement,
  loadManagedClearConflict,
  evseManagedProfileIdConflict,
  unitBoxDefaultClearConflict,
  unitBoxDefaultConflict,
} from '../lib/charging-profile-id.js';
import { loadManagementProfileConflict } from '../lib/load-management-profile-conflict.js';

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

  const setProfile = (profile: ReturnType<typeof stationMax>) => ({
    evseId: 0,
    chargingProfile: {
      id: profile.profileId,
      chargingProfilePurpose: profile.purpose,
      stackLevel: profile.stackLevel,
    },
  });

  it('refuses it on a managed station (the one rule, loadManagementProfileConflict)', async () => {
    // The station by its identity, then whether load management manages it.
    selectRows.queue = [[{ id: 'sta_1' }], [{ id: 'sta_1' }]];
    const conflict = await loadManagementProfileConflict(
      'CS-1',
      'SetChargingProfile',
      setProfile(stationMax(1)),
      { maxExternalId: null },
    );
    expect(conflict).toContain('would override the load management limit');
  });

  it('accepts it on a station load management does not manage', async () => {
    selectRows.queue = [[]];
    expect(
      await loadManagementProfileConflict('CS-1', 'SetChargingProfile', setProfile(stationMax(1)), {
        maxExternalId: null,
      }),
    ).toBeNull();
  });

  it('accepts a stack level 0 station max profile without reading the database', async () => {
    selectRows.queue = [[{ id: 'sta_1' }]];
    expect(
      await loadManagementProfileConflict('CS-1', 'SetChargingProfile', setProfile(stationMax(0)), {
        maxExternalId: null,
      }),
    ).toBeNull();
    expect(selectRows.queue).toHaveLength(1);
    selectRows.queue = [];
  });

  it('refuses UsePriorityCharging on a managed station only', async () => {
    selectRows.queue = [[{ id: 'sta_1' }], [{ id: 'sta_1' }]];
    expect(await loadManagementProfileConflict('CS-1', 'UsePriorityCharging', {})).toContain(
      'Priority charging',
    );
    selectRows.queue = [[]];
    expect(await loadManagementProfileConflict('CS-1', 'UsePriorityCharging', {})).toBeNull();
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

  it('names a session per EVSE on a managed station in EVSE mode', async () => {
    selectRows.executed = [[{ id: 'sta_1', mode: 'evse' }]];
    expect(await isEvseManagedTransaction('CS-1', 'tx-1')).toBe(true);
    expect(selectRows.executed).toHaveLength(0);
  });

  it('names a session per EVSE on a station with an AC session under a tariff limit', async () => {
    selectRows.executed = [
      [{ id: 'sta_1', mode: 'station' }],
      [{ session_id: 'ses_1', charging_kind: null, connector_type: 'Type2', max_power_kw: '22' }],
    ];
    expect(await isEvseManagedTransaction('CS-1', 'tx-1')).toBe(true);
  });

  it('leaves a station whose only capped session is DC, or none, to manual TxProfiles', async () => {
    selectRows.executed = [
      [{ id: 'sta_1', mode: 'station' }],
      [{ session_id: 'ses_1', charging_kind: null, connector_type: 'CCS2', max_power_kw: '150' }],
    ];
    expect(await isEvseManagedTransaction('CS-1', 'tx-1')).toBe(false);
    selectRows.executed = [[{ id: 'sta_1', mode: 'station' }], []];
    expect(await isEvseManagedConnectorSession('CS-1', 1)).toBe(false);
    selectRows.executed = [[]];
    expect(await isEvseManagedConnectorSession('CS-1', 1)).toBe(false);
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
    // The 2.1 form (a fleet reservation, a template) reaches a 1.6 station as a
    // TxProfile of connector evseId: checked on that connector (final review, Low 1).
    expect(txProfileConnectorWithoutTransaction(txProfile(undefined))).toBe(1);
    expect(txProfileConnectorWithoutTransaction(txProfile('tx-1'))).toBeNull();
    expect(txProfileConnectorWithoutTransaction({ ...txProfile(undefined), evseId: 0 })).toBeNull();
  });

  it('finds the planned active session on a connector', async () => {
    selectRows.executed = [[{ planned: 1 }], []];
    expect(await isPlannedConnectorSession('DEPOT-01', 1)).toBe(true);
    expect(await isPlannedConnectorSession('DEPOT-01', 2)).toBe(false);
  });
});

describe('manual clears of the EVSE limit of a session limited per EVSE', () => {
  const sessions = [{ transaction_id: 'tx-1', evse_id: 1 }];
  const evseMode = [{ id: 'sta_1', mode: 'evse' }];

  it('finds a clear by the EVSE limit profile id, by TxProfile or by the EVSE', async () => {
    const id = chargingNeedsProfileId('CS-1', 'tx-1');
    for (const payload of [
      { chargingProfileId: id },
      { chargingProfileCriteria: { chargingProfilePurpose: 'TxProfile' } },
      { chargingProfileCriteria: { evseId: 1 } },
      { id },
      { connectorId: 1, chargingProfilePurpose: 'TxProfile' },
      {},
    ]) {
      selectRows.executed = [sessions, evseMode];
      expect(await evseManagedClearConflict('CS-1', payload), JSON.stringify(payload)).toBe('tx-1');
    }
  });

  it('passes a clear of another EVSE or id, and a session the station limits as a whole', async () => {
    selectRows.executed = [sessions];
    expect(
      await evseManagedClearConflict('CS-1', { chargingProfileCriteria: { evseId: 2 } }),
    ).toBeNull();
    selectRows.executed = [sessions];
    expect(
      await evseManagedClearConflict('CS-1', {
        chargingProfileId: chargingNeedsProfileId('CS-1', 'tx-1') + 1,
      }),
    ).toBeNull();
    selectRows.executed = [sessions, [{ id: 'sta_1', mode: 'station' }], []];
    expect(await evseManagedClearConflict('CS-1', {})).toBeNull();
    selectRows.executed = [sessions, []];
    expect(await evseManagedClearConflict('CS-1', {})).toBeNull();
  });

  it('reads no database for another purpose or the station EVSE', async () => {
    selectRows.executed = [sessions];
    expect(
      await evseManagedClearConflict('CS-1', {
        chargingProfileCriteria: { chargingProfilePurpose: 'ChargingStationMaxProfile' },
      }),
    ).toBeNull();
    expect(await evseManagedClearConflict('CS-1', { connectorId: 0 })).toBeNull();
    expect(selectRows.executed).toHaveLength(1);
    selectRows.executed = [];
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
    expect(
      await loadManagementProfileConflict(
        'DEPOT-01',
        'SetChargingProfile',
        {
          evseId: 0,
          chargingProfile: {
            id: planId,
            chargingProfilePurpose: 'TxDefaultProfile',
            stackLevel: 0,
          },
        },
        { maxExternalId: null },
      ),
    ).toContain('tx-1');
    selectRows.executed = [];
  });

  it('reads no database for an id below the plan range or no id', async () => {
    selectRows.executed = [planned];
    expect(await plannedProfileIdConflict('DEPOT-01', 100)).toBeNull();
    expect(await plannedProfileIdConflict('DEPOT-01', null)).toBeNull();
    expect(selectRows.executed).toHaveLength(1);
    selectRows.executed = [];
  });
});

describe('other profile writers on a managed station (safety spec I7)', () => {
  it('refuses PriorityCharging and LocalGeneration at any stack level', () => {
    for (const purpose of ['PriorityCharging', 'LocalGeneration']) {
      const profile = { profileId: 7, purpose, stackLevel: 0 };
      expect(mayOverrideLoadManagement(profile)).toBe(true);
      expect(overridesLoadManagement(profile, null)).toBe(true);
    }
    // TxDefault and another TxProfile stay below the station limit.
    for (const purpose of ['TxDefaultProfile', 'TxProfile']) {
      expect(overridesLoadManagement({ profileId: 7, purpose, stackLevel: 9 }, null)).toBe(false);
    }
  });

  const clear = (c: Partial<Parameters<typeof clearRemovesLoadManagement>[0]>) => ({
    chargingProfileId: null,
    chargingProfilePurpose: null,
    stackLevel: null,
    evseId: null,
    ...c,
  });

  it('finds every clear that can match the station limit or the credit profile', () => {
    for (const criteria of [
      clear({}),
      clear({ chargingProfileId: 1_000_000_000 }),
      clear({ chargingProfileId: 1_000_000_001 }),
      clear({ chargingProfilePurpose: 'ChargingStationMaxProfile' }),
      clear({ chargingProfilePurpose: 'ChargePointMaxProfile', stackLevel: 1 }),
      clear({ stackLevel: 2 }),
      clear({ evseId: 0 }),
    ]) {
      expect(clearRemovesLoadManagement(criteria, null), JSON.stringify(criteria)).toBe(true);
    }
    for (const criteria of [
      clear({ chargingProfileId: 5 }),
      clear({ chargingProfilePurpose: 'TxDefaultProfile' }),
      clear({ chargingProfilePurpose: 'ChargingStationMaxProfile', stackLevel: 0 }),
      clear({ stackLevel: 3 }),
      clear({ evseId: 1 }),
    ]) {
      expect(clearRemovesLoadManagement(criteria, null), JSON.stringify(criteria)).toBe(false);
    }
    // The ids follow MaxExternalConstraintsId.
    expect(
      clearRemovesLoadManagement(clear({ chargingProfileId: 1_000_000_000 }), 2_000_000_000),
    ).toBe(false);
    expect(
      clearRemovesLoadManagement(clear({ chargingProfileId: 2_000_000_001 }), 2_000_000_000),
    ).toBe(true);
  });

  it('refuses such a clear only on a managed station, reading nothing for other clears', async () => {
    selectRows.queue = [[{ id: 'sta_1' }], [{ id: 'sta_1' }]];
    expect(await loadManagedClearConflict('CS-1', {})).toBe(true);
    selectRows.queue = [[{ id: 'sta_1' }], []];
    expect(await loadManagedClearConflict('CS-1', {})).toBe(false);
    selectRows.queue = [];
    expect(await loadManagedClearConflict('CS-1', { chargingProfileId: 5 })).toBe(false);
    expect(
      await loadManagedClearConflict('CS-1', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile' },
      }),
    ).toBe(false);
  });

  it('refuses any profile with the TxProfile id of a session limited per EVSE', async () => {
    const id = chargingNeedsProfileId('CS-1', 'tx-1');
    expect(await evseManagedProfileIdConflict('CS-1', PLAN_TX_PROFILE_ID_MIN - 1)).toBeNull();
    selectRows.executed = [[{ transaction_id: 'tx-1' }], [{ id: 'sta_1', mode: 'evse' }]];
    expect(await evseManagedProfileIdConflict('CS-1', id)).toBe('tx-1');
    selectRows.executed = [[{ transaction_id: 'tx-1' }], [{ id: 'sta_1', mode: 'station' }], []];
    expect(await evseManagedProfileIdConflict('CS-1', id)).toBeNull();
    selectRows.executed = [];
  });
});

describe('unit box defaults belong to load management (I7)', () => {
  const managed = (): void => {
    // Box EVSEs, then the managed station check (station row, managed ids).
    selectRows.executed = [[{ evse_id: 3 }, { evse_id: 4 }]];
    selectRows.queue = [[{ id: 'sta_1' }], [{ id: 'sta_1' }], []];
  };
  const set = (purpose: string, stackLevel: number, evseId: number, id = 7) => ({
    evseId,
    chargingProfile: { id, chargingProfilePurpose: purpose, stackLevel },
  });

  it('refuses another TxDefaultProfile at stack level 1 or above on EVSE 0 or a box EVSE', async () => {
    managed();
    expect(await unitBoxDefaultConflict('CS-1', set('TxDefaultProfile', 1, 3))).toBe(3);
    managed();
    expect(await unitBoxDefaultConflict('CS-1', set('TxDefaultProfile', 2, 0))).toBe(0);
    managed();
    expect(await unitBoxDefaultConflict('CS-1', set('TxDefaultProfile', 1, 9))).toBeNull();
    expect(await unitBoxDefaultConflict('CS-1', set('TxDefaultProfile', 0, 3))).toBeNull();
    expect(await unitBoxDefaultConflict('CS-1', set('TxProfile', 1, 3))).toBeNull();
    selectRows.executed = [];
    selectRows.queue = [];
  });

  it('refuses any profile with the default id of a box EVSE', async () => {
    managed();
    expect(await unitBoxDefaultConflict('CS-1', set('TxProfile', 0, 1, 1_000_000_005))).toBe(4);
    selectRows.executed = [[]];
    expect(await unitBoxDefaultConflict('CS-1', set('TxProfile', 0, 1, 1_000_000_005))).toBeNull();
    selectRows.queue = [];
  });

  it('refuses a clear that can remove a default', async () => {
    managed();
    expect(await unitBoxDefaultClearConflict('CS-1', { chargingProfileId: 1_000_000_004 })).toBe(
      true,
    );
    managed();
    expect(
      await unitBoxDefaultClearConflict('CS-1', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile' },
      }),
    ).toBe(true);
    expect(
      await unitBoxDefaultClearConflict('CS-1', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxProfile' },
      }),
    ).toBe(false);
    expect(await unitBoxDefaultClearConflict('CS-1', { chargingProfileId: 12 })).toBe(false);
    selectRows.executed = [];
    selectRows.queue = [];
  });
});
