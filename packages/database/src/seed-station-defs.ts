// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Station definitions the demo seed (seed.ts) and the dev fixture seed
// (seed-dev-stations.ts) share, kept out of the seed scripts so tests can import them.

import { isOcpp2x, type OcppProtocol } from '@evtivity/lib/ocpp-version';

/** Demo stations 0-999 speak OCPP 2.x, 1000-1999 OCPP 1.6. */
export const DEMO_OCPP16_FROM_INDEX = 1000;

/**
 * The OCPP protocol of demo station `index` (station id CS-<index + 3>): 1.6 from
 * index 1000, else every third station (index 0, 3, 6, ...) 2.0.1 and the rest 2.1.
 */
export function demoStationProtocol(index: number): OcppProtocol {
  if (index >= DEMO_OCPP16_FROM_INDEX) return 'ocpp1.6';
  return index % 3 === 0 ? 'ocpp2.0.1' : 'ocpp2.1';
}

/** A station's own configuration template version: a 2.1 template also reaches 2.0.1 stations. */
export function configTemplateVersion(protocol: OcppProtocol): '1.6' | '2.1' {
  return isOcpp2x(protocol) ? '2.1' : '1.6';
}

export interface DevStationDef {
  stationId: string;
  vendorId: string;
  model: string;
  serialNumber: string;
  ocppProtocol: OcppProtocol;
  isSimulator: boolean;
  connector: { type: string; power: string; amps: number };
}

/** Station id of the dev 2.0.1 simulator, outside the demo range CS-0003..CS-2002. */
export const DEV_OCPP201_STATION_ID = 'CS-9001';

/**
 * The dev fixture stations: two real IoCharger stations and one simulator per
 * OCPP version (CS-0001 1.6, CS-0002 2.1, CS-9001 2.0.1). CS-0001 and CS-0002
 * also come from migration 0001. Not CS-0003: it is the first demo station, and
 * the demo seed skips its data when CS-0003 exists.
 */
export function devStationDefs(vendorIds: {
  ioCharger: string;
  evtivity: string;
}): DevStationDef[] {
  return [
    {
      stationId: 'IOCHARGER-001',
      vendorId: vendorIds.ioCharger,
      model: 'IOCAH10-50',
      serialNumber: 'A10E231922830',
      ocppProtocol: 'ocpp1.6',
      isSimulator: false,
      connector: { type: 'Type1', power: '7.68', amps: 32 },
    },
    {
      stationId: 'IOCHARGER-002',
      vendorId: vendorIds.ioCharger,
      model: 'IOCAH10-50',
      serialNumber: 'A10E231922831',
      ocppProtocol: 'ocpp2.1',
      isSimulator: false,
      connector: { type: 'Type1', power: '7.68', amps: 32 },
    },
    {
      stationId: 'CS-0001',
      vendorId: vendorIds.evtivity,
      model: 'DCFC-150',
      serialNumber: 'SN-2026-0001',
      ocppProtocol: 'ocpp1.6',
      isSimulator: true,
      connector: { type: 'CCS2', power: '150', amps: 375 },
    },
    {
      stationId: 'CS-0002',
      vendorId: vendorIds.evtivity,
      model: 'DCFC-150',
      serialNumber: 'SN-2026-0002',
      ocppProtocol: 'ocpp2.1',
      isSimulator: true,
      connector: { type: 'CCS2', power: '150', amps: 375 },
    },
    {
      stationId: DEV_OCPP201_STATION_ID,
      vendorId: vendorIds.evtivity,
      model: 'AC 2.0.1',
      serialNumber: 'SN-2026-9001',
      ocppProtocol: 'ocpp2.0.1',
      isSimulator: true,
      connector: { type: 'Type2', power: '22', amps: 32 },
    },
  ];
}
