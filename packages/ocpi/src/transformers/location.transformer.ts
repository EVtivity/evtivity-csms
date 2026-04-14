// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  OcpiLocation,
  OcpiEVSE,
  OcpiConnector,
  OcpiEVSEStatus,
  OcpiConnectorType,
  OcpiConnectorFormat,
  OcpiPowerType,
  OcpiVersion,
} from '../types/ocpi.js';

// Internal DB types (matching Drizzle schema select results)

interface SiteRow {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string;
  contactName: string | null;
  contactIsPublic: boolean;
  updatedAt: Date;
}

interface EvseRow {
  id: string;
  evseId: number;
  updatedAt: Date;
  connectors: ConnectorRow[];
}

interface ConnectorRow {
  id: string;
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: string | null;
  maxCurrentAmps: number | null;
  status: string;
  updatedAt: Date;
}

interface LocationTransformInput {
  site: SiteRow;
  evses: EvseRow[];
  ocpiLocationId: string;
  countryCode: string;
  partyId: string;
  tariffIds?: string[];
}

const EVSE_STATUS_MAP: Record<string, OcpiEVSEStatus> = {
  available: 'AVAILABLE',
  occupied: 'CHARGING',
  charging: 'CHARGING',
  preparing: 'AVAILABLE',
  ev_connected: 'AVAILABLE',
  finishing: 'AVAILABLE',
  suspended_ev: 'BLOCKED',
  suspended_evse: 'INOPERATIVE',
  reserved: 'RESERVED',
  unavailable: 'INOPERATIVE',
  faulted: 'OUTOFORDER',
  idle: 'CHARGING',
  discharging: 'CHARGING',
};

const CONNECTOR_TYPE_MAP: Record<string, OcpiConnectorType> = {
  CCS2: 'IEC_62196_T2_COMBO',
  CCS1: 'IEC_62196_T1_COMBO',
  CHAdeMO: 'CHADEMO',
  Type2: 'IEC_62196_T2',
  Type1: 'IEC_62196_T1',
  GBT: 'GBT_DC',
  Tesla: 'TESLA_S',
  NACS: 'IEC_62196_T1_COMBO',
};

function mapConnectorType(connectorType: string | null): OcpiConnectorType {
  if (connectorType == null) return 'IEC_62196_T2';
  return CONNECTOR_TYPE_MAP[connectorType] ?? 'IEC_62196_T2';
}

function inferConnectorFormat(connectorType: string | null): OcpiConnectorFormat {
  // DC connectors typically use cables; AC connectors often use sockets
  if (connectorType == null) return 'CABLE';
  const dcTypes = new Set(['CCS2', 'CCS1', 'CHAdeMO', 'GBT', 'Tesla', 'NACS']);
  return dcTypes.has(connectorType) ? 'CABLE' : 'SOCKET';
}

function inferPowerType(connectorType: string | null): OcpiPowerType {
  if (connectorType == null) return 'AC_3_PHASE';
  const dcTypes = new Set(['CCS2', 'CCS1', 'CHAdeMO', 'GBT', 'Tesla', 'NACS']);
  return dcTypes.has(connectorType) ? 'DC' : 'AC_3_PHASE';
}

function inferVoltageAndAmperage(
  maxPowerKw: string | null,
  powerType: OcpiPowerType,
): { voltage: number; amperage: number } {
  const power = maxPowerKw != null ? Number(maxPowerKw) : 22;
  if (powerType === 'DC') {
    // DC: typically 400V, calculate amperage
    const voltage = 400;
    const amperage = Math.round((power * 1000) / voltage);
    return { voltage, amperage };
  }
  // AC: 230V single-phase or 400V three-phase
  const voltage = powerType === 'AC_1_PHASE' ? 230 : 400;
  const amperage = Math.round((power * 1000) / voltage);
  return { voltage, amperage };
}

function transformConnector(
  connector: ConnectorRow,
  version: OcpiVersion,
  tariffIds?: string[],
): OcpiConnector {
  const ocpiType = mapConnectorType(connector.connectorType);
  const format = inferConnectorFormat(connector.connectorType);
  const powerType = inferPowerType(connector.connectorType);
  const { voltage, amperage } = inferVoltageAndAmperage(connector.maxPowerKw, powerType);

  const result: OcpiConnector = {
    id: String(connector.connectorId),
    standard: ocpiType,
    format,
    power_type: powerType,
    max_voltage: voltage,
    max_amperage: connector.maxCurrentAmps ?? amperage,
    last_updated: connector.updatedAt.toISOString(),
  };

  if (connector.maxPowerKw != null) {
    result.max_electric_power = Number(connector.maxPowerKw) * 1000;
  }

  if (tariffIds != null && tariffIds.length > 0) {
    result.tariff_ids = tariffIds;
  }

  if (version === '2.3.0') {
    // 2.3.0-specific connector fields (accessibility, AFIR) will be added here
  }

  return result;
}

function deriveEvseStatus(connectors: ConnectorRow[]): OcpiEVSEStatus {
  if (connectors.length === 0) return 'UNKNOWN';
  const statuses = connectors.map((c) => EVSE_STATUS_MAP[c.status] ?? 'UNKNOWN');
  if (statuses.includes('OUTOFORDER')) return 'OUTOFORDER';
  if (statuses.includes('CHARGING')) return 'CHARGING';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('RESERVED')) return 'RESERVED';
  if (statuses.includes('INOPERATIVE')) return 'INOPERATIVE';
  if (statuses.includes('AVAILABLE')) return 'AVAILABLE';
  return 'UNKNOWN';
}

function transformEvse(
  evse: EvseRow,
  siteId: string,
  version: OcpiVersion,
  tariffIds?: string[],
): OcpiEVSE {
  const status = deriveEvseStatus(evse.connectors);

  return {
    uid: `${siteId}-${String(evse.evseId)}`,
    evse_id: `${siteId}-EVSE-${String(evse.evseId)}`,
    status,
    connectors: evse.connectors.map((c) => transformConnector(c, version, tariffIds)),
    capabilities: ['REMOTE_START_STOP_CAPABLE', 'RFID_READER'],
    last_updated: evse.updatedAt.toISOString(),
  };
}

export function transformLocation(
  input: LocationTransformInput,
  version: OcpiVersion,
): OcpiLocation {
  const { site, evses, ocpiLocationId, countryCode, partyId, tariffIds } = input;

  const location: OcpiLocation = {
    country_code: countryCode,
    party_id: partyId,
    id: ocpiLocationId,
    publish: true,
    name: site.name,
    address: site.address ?? 'Unknown',
    city: site.city ?? 'Unknown',
    country: site.country ?? 'US',
    coordinates: {
      latitude: site.latitude ?? '0',
      longitude: site.longitude ?? '0',
    },
    time_zone: site.timezone,
    evses: evses.map((e) => transformEvse(e, site.id, version, tariffIds)),
    last_updated: site.updatedAt.toISOString(),
  };

  if (site.postalCode != null) {
    location.postal_code = site.postalCode;
  }

  if (site.state != null) {
    location.state = site.state;
  }

  if (site.contactIsPublic && site.contactName != null) {
    location.operator = { name: site.contactName };
  }

  if (version === '2.3.0') {
    location.opening_times = { twentyfourseven: true };
  }

  return location;
}

export function transformEvseStandalone(
  evse: EvseRow,
  siteId: string,
  version: OcpiVersion,
  tariffIds?: string[],
): OcpiEVSE {
  return transformEvse(evse, siteId, version, tariffIds);
}

export function transformConnectorStandalone(
  connector: ConnectorRow,
  version: OcpiVersion,
  tariffIds?: string[],
): OcpiConnector {
  return transformConnector(connector, version, tariffIds);
}
