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
import { ocpiEvseUid, ocpiEvseId } from '../lib/evse-uid.js';

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
  hoursOfOperation: string | null;
  updatedAt: Date;
}

export interface EvseRow {
  id: string;
  /** Internal DB id of the owning station. Used by the OCPI transformer to
   *  apply per-station maintenance masking. */
  stationId: string;
  // OCPP identifier of the owning station, for the readable evse_id.
  stationOcppId: string;
  evseId: number;
  updatedAt: Date;
  /** True when the owning station cannot start a session at all
   *  (`isStationLevelUnavailable`: disabled, firmware installing or failed,
   *  station-reported Unavailable or Faulted). Masks the EVSE as INOPERATIVE
   *  the same way maintenance does. */
  stationLevelUnavailable: boolean;
  /** True when the EVSE left the location: its station was deleted (soft
   *  delete, onboarding status `blocked`), or the EVSE is a removed EVSE of
   *  `ocpi_removed_evses` (deleted, or its station moved to another site).
   *  OCPI 8.1: a removed EVSE is reported REMOVED. */
  removed?: boolean;
  /** OCPI tariff ids for the connectors of this EVSE, for the partner the
   *  location is rendered for (`connectorTariffIds`). Omitted when none. */
  tariffIds?: string[];
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

export interface LocationTransformInput {
  site: SiteRow;
  evses: EvseRow[];
  ocpiLocationId: string;
  countryCode: string;
  partyId: string;
  /** Report every EVSE as REMOVED: the location is unpublished for the
   *  partner it is rendered for (OCPI 8.1, there is no DELETE). */
  allRemoved?: boolean;
  /** Maintenance coverage for this location. When `allAffected` is true every
   *  EVSE in the location reports INOPERATIVE regardless of its connector
   *  status. When `allAffected` is false, only stations whose internal DB id
   *  appears in `affectedStationIds` are marked INOPERATIVE. */
  maintenance?: {
    allAffected: boolean;
    affectedStationIds: Set<string>;
  };
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

const DC_CONNECTOR_TYPES = new Set(['CCS2', 'CCS1', 'CHAdeMO', 'GBT', 'Tesla', 'NACS']);

function inferConnectorFormat(connectorType: string | null): OcpiConnectorFormat {
  // DC connectors typically use cables; AC connectors often use sockets
  if (connectorType == null) return 'CABLE';
  return DC_CONNECTOR_TYPES.has(connectorType) ? 'CABLE' : 'SOCKET';
}

function inferPowerType(connectorType: string | null): OcpiPowerType {
  if (connectorType == null) return 'AC_3_PHASE';
  return DC_CONNECTOR_TYPES.has(connectorType) ? 'DC' : 'AC_3_PHASE';
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

function evseStatus(evse: EvseRow, underMaintenance: boolean, removed: boolean): OcpiEVSEStatus {
  if (removed || evse.removed === true) return 'REMOVED';
  if (underMaintenance || evse.stationLevelUnavailable) return 'INOPERATIVE';
  return deriveEvseStatus(evse.connectors);
}

function transformEvse(
  evse: EvseRow,
  version: OcpiVersion,
  underMaintenance: boolean,
  removed: boolean,
): OcpiEVSE {
  return {
    uid: ocpiEvseUid(evse),
    evse_id: ocpiEvseId(evse.stationOcppId, evse.evseId),
    status: evseStatus(evse, underMaintenance, removed),
    connectors: evse.connectors.map((c) => transformConnector(c, version, evse.tariffIds)),
    capabilities: ['REMOTE_START_STOP_CAPABLE', 'RFID_READER'],
    last_updated: evse.updatedAt.toISOString(),
  };
}

function isEvseUnderMaintenance(
  evse: EvseRow,
  maintenance?: { allAffected: boolean; affectedStationIds: Set<string> },
): boolean {
  if (maintenance == null) return false;
  if (maintenance.allAffected) return true;
  return maintenance.affectedStationIds.has(evse.stationId);
}

export function transformLocation(
  input: LocationTransformInput,
  version: OcpiVersion,
): OcpiLocation {
  const { site, evses, ocpiLocationId, countryCode, partyId } = input;

  // OCPI Location.coordinates is required. Callers (push.service,
  // cpo/locations routes) gate on non-null coordinates before reaching here so
  // we don't fall back to (0, 0) and publish null-island locations to partners.
  if (site.latitude == null || site.longitude == null) {
    throw new Error(`Cannot transform OCPI Location for site ${site.id}: missing coordinates`);
  }

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
      latitude: site.latitude,
      longitude: site.longitude,
    },
    time_zone: site.timezone,
    evses: evses.map((e) =>
      transformEvse(
        e,
        version,
        isEvseUnderMaintenance(e, input.maintenance),
        input.allRemoved === true,
      ),
    ),
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

  // OCPI opening_times is a structured object (regular_hours[], exceptional_*).
  // EVtivity stores a free-form text column, so we cannot map it into the
  // structured shape. Only assert 24/7 when the operator hasn't set any hours;
  // when they have, omit opening_times so partners treat the schedule as
  // unknown rather than receive a misleading "always open" signal.
  if (version === '2.3.0' && site.hoursOfOperation == null) {
    location.opening_times = { twentyfourseven: true };
  }

  return location;
}

export function transformEvseStandalone(
  evse: EvseRow,
  version: OcpiVersion,
  underMaintenance = false,
): OcpiEVSE {
  return transformEvse(evse, version, underMaintenance, false);
}

export function transformConnectorStandalone(
  connector: ConnectorRow,
  version: OcpiVersion,
  tariffIds?: string[],
): OcpiConnector {
  return transformConnector(connector, version, tariffIds);
}
