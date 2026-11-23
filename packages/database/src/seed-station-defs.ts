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

/**
 * The voltage of a demo AC Level 2 circuit: a 2-pole 208 V branch circuit of a
 * 208Y/120 V panelboard (seed-site-power-plan.ts, NEC 625.40).
 */
export const DEMO_AC_CIRCUIT_VOLTS = 208;

/**
 * An AC Level 2 connector's rating: its current at the 208 V circuit that feeds
 * it, so the circuit carries it (NFPA 70 (NEC) 2023, 625.41: the circuit is
 * sized at 125 percent of this continuous load). SAE J1772 Level 2 runs at 208
 * to 240 V, up to 80 A; the same current gives 7.68 kW at 240 V and 6.66 kW at
 * 208 V (ChargePoint CT4000 datasheet: 32 A per port, "6.6 kW at 208 V").
 */
export function demoAcConnectorKw(amps: number): number {
  return Math.round((amps * DEMO_AC_CIRCUIT_VOLTS) / 10) / 100;
}

/**
 * The AC connector ratings earlier demo seeds wrote (kW and A, a power the 208 V
 * circuit could not carry), and the rating that replaces each on a rerun while a
 * connector still holds it. DualPlug's 63 A port became 48 A: a dual-port
 * pedestal shares one 32 A circuit, and the circuit assignment check counts the
 * per-EVSE nameplate, so a port above 48 A would ask more than the panel
 * routes' maximum oversubscription ratio of 3.
 */
export const DEMO_AC_RATINGS_BEFORE: ReadonlyArray<{
  kw: number;
  amps: number;
  to: { kw: number; amps: number };
}> = [
  { kw: 7, amps: 32, to: { kw: demoAcConnectorKw(32), amps: 32 } },
  { kw: 19, amps: 32, to: { kw: demoAcConnectorKw(32), amps: 32 } },
  { kw: 22, amps: 32, to: { kw: demoAcConnectorKw(32), amps: 32 } },
  { kw: 11, amps: 16, to: { kw: demoAcConnectorKw(16), amps: 16 } },
  { kw: 40, amps: 48, to: { kw: demoAcConnectorKw(48), amps: 48 } },
  { kw: 43, amps: 63, to: { kw: demoAcConnectorKw(48), amps: 48 } },
];

/**
 * The station models of the demo seed's OCPP 2.x stations (power kW, connector
 * type and current). `outputs`: a DC split system's EVSEs, one per satellite
 * dispenser; every other model has two EVSEs (a dual-outlet dispenser or a
 * dual-port pedestal). The Kempower C-Series double cabinet delivers 200 kW
 * continuous (C502P200, Kempower C-Series Power Unit datasheet 2022,
 * https://www.nee.ca/wp-content/uploads/2023/08/Kempower-C-Series-Power-Units.pdf)
 * to up to 8 single satellites, here 4, each with a 300 A CCS1 cable (cable
 * code E, Kempower S-Series Charging Satellite datasheet 2022,
 * https://www.nee.ca/wp-content/uploads/2023/08/Kempower-S-Series-ETL-Datasheet-Rev-2.2-0622.pdf).
 * A small single dispenser never gets three or more EVSEs.
 */
export const STATION_MODELS: Array<{
  model: string;
  power: number;
  type: string;
  amps: number;
  outputs?: number;
}> = [
  { model: 'Terra 360', power: 360, type: 'CCS1', amps: 500 },
  { model: 'Terra 184', power: 180, type: 'CCS1', amps: 250 },
  { model: 'CT4000', power: demoAcConnectorKw(32), type: 'Type1', amps: 32 },
  { model: 'CP6000', power: demoAcConnectorKw(32), type: 'Type1', amps: 32 },
  { model: 'RTM75', power: 75, type: 'CCS1', amps: 200 },
  { model: 'RT50', power: 50, type: 'CCS1', amps: 125 },
  { model: 'BusinessLine', power: demoAcConnectorKw(32), type: 'Type1', amps: 32 },
  { model: 'Troniq 50', power: 50, type: 'CCS1', amps: 125 },
  { model: 'Pulsar Plus', power: demoAcConnectorKw(16), type: 'Type1', amps: 16 },
  { model: 'JuiceBox', power: demoAcConnectorKw(48), type: 'Type1', amps: 48 },
  { model: 'Series 6', power: 150, type: 'CCS1', amps: 350 },
  { model: 'IQ 200', power: 200, type: 'CCS1', amps: 500 },
  { model: 'C-Series Satellites', power: 200, type: 'CCS1', amps: 300, outputs: 4 },
];

/** Simpler models typical of OCPP 1.6-era chargers. */
export const STATION_MODELS_16: Array<{
  model: string;
  power: number;
  type: string;
  amps: number;
}> = [
  { model: 'CT4000 (1.6)', power: demoAcConnectorKw(32), type: 'Type1', amps: 32 },
  { model: 'AV-30 (1.6)', power: demoAcConnectorKw(32), type: 'Type1', amps: 32 },
  { model: 'QC-50 (1.6)', power: 50, type: 'CCS1', amps: 125 },
  { model: 'DualPlug (1.6)', power: demoAcConnectorKw(48), type: 'Type1', amps: 48 },
];
