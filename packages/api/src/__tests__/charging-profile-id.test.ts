// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

// Rows the next `db.select(...)` chain resolves to, in order.
const selectRows = vi.hoisted(() => ({ queue: [] as unknown[][] }));

vi.mock('@evtivity/database', () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    chain['from'] = () => chain;
    chain['innerJoin'] = () => chain;
    chain['where'] = () => Promise.resolve(selectRows.queue.shift() ?? []);
    return chain;
  };
  return {
    db: { select },
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
}));

import {
  assertNotLoadManaged,
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
