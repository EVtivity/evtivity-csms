// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  chargingProfileClearCriteria,
  chargingProfileClearFilter,
} from '../charging-profile-clear.js';

describe('chargingProfileClearCriteria', () => {
  it('reads the 2.1 request', () => {
    expect(
      chargingProfileClearCriteria({
        chargingProfileId: 4,
        chargingProfileCriteria: {
          chargingProfilePurpose: 'TxDefaultProfile',
          stackLevel: 1,
          evseId: 0,
        },
      }),
    ).toEqual({
      chargingProfileId: 4,
      chargingProfilePurpose: 'TxDefaultProfile',
      stackLevel: 1,
      evseId: 0,
    });
  });

  it('reads the native 1.6 request', () => {
    expect(
      chargingProfileClearCriteria({
        id: 9,
        connectorId: 2,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        stackLevel: 0,
      }),
    ).toEqual({
      chargingProfileId: 9,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      stackLevel: 0,
      evseId: 2,
    });
  });

  it('reads an empty clear as no criteria', () => {
    expect(chargingProfileClearCriteria({})).toEqual({
      chargingProfileId: null,
      chargingProfilePurpose: null,
      stackLevel: null,
      evseId: null,
    });
  });
});

describe('chargingProfileClearFilter', () => {
  it('keeps values out of the path text and matches both purpose names', () => {
    const filter = chargingProfileClearFilter({
      chargingProfileId: null,
      chargingProfilePurpose: 'ChargePointMaxProfile',
      stackLevel: 2,
      evseId: 1,
    });
    expect(filter.path).not.toContain('ChargePointMaxProfile');
    expect(filter.vars).toMatchObject({
      purpose: 'ChargePointMaxProfile',
      alias: 'ChargingStationMaxProfile',
      stackLevel: 2,
    });
    expect(filter.evseId).toBe(1);
  });
});
