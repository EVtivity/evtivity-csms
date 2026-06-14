// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { type StationConfig } from '../station-simulator.js';

// Tagged-template no-op SQL stub: returns an empty array for any query so a
// StationSimulator's DB writes (updateStationStatus, cache persistors) succeed
// silently without a real postgres pool.
export function noopSql(): postgres.Sql {
  return ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
}

// A single-EVSE OCPP 2.1 station config. Override any field per test.
export function makeConfig(overrides: Partial<StationConfig> = {}): StationConfig {
  return {
    id: 'css_test',
    stationId: 'TEST-SIM',
    ocppProtocol: 'ocpp2.1',
    securityProfile: 0,
    targetUrl: 'ws://localhost:7103',
    vendorName: 'V',
    model: 'M',
    serialNumber: 'SN',
    firmwareVersion: '1.0',
    evses: [
      {
        evseId: 1,
        connectorId: 1,
        connectorType: 'ac_type2',
        maxPowerW: 22000,
        phases: 3,
        voltage: 230,
      },
    ],
    ...overrides,
  };
}
