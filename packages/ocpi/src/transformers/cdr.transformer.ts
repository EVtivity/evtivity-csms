// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { toOcpiPrice } from '../lib/ocpi-price.js';
import type { OcpiCdrCost } from '../lib/ocpi-price.js';
import { chargingPeriods, cdrToken, sessionTimes, whToKwh } from '../lib/charging-periods.js';
import type { CdrTokenSource } from '../lib/charging-periods.js';
import type { OcpiCdr, OcpiCdrLocation, OcpiTariff, OcpiVersion } from '../types/ocpi.js';
import type { Ocpi230Tariff } from '../types/ocpi-2.3.0.js';

interface CdrInput {
  sessionId: string;
  transactionId: string;
  startedAt: Date;
  endedAt: Date;
  energyDeliveredWh: string | null;
  currency: string;
  /** Minutes the EV was connected without charging. */
  idleMinutes: number;
}

interface CdrLocationInput {
  /** The OCPI location id (the published id, else the site id). */
  locationId: string;
  siteName: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  state: string | null;
  country: string | null;
  latitude: string | null;
  longitude: string | null;
  evseUid: string;
  evseId: string;
  connectorId: string;
  connectorType: string | null;
}

interface CdrTransformInput {
  session: CdrInput;
  /** The final cost split into net and tax, in total and per dimension (`ocpiCdrCost`). */
  cost: OcpiCdrCost;
  location: CdrLocationInput;
  countryCode: string;
  partyId: string;
  cdrId: string;
  token: CdrTokenSource;
  /** The published tariff the session was billed with, as the partner sees it. */
  tariff?: OcpiTariff | Ocpi230Tariff;
}

function mapConnectorStandard(
  connectorType: string | null,
): 'IEC_62196_T2_COMBO' | 'IEC_62196_T1_COMBO' | 'CHADEMO' | 'IEC_62196_T2' | 'IEC_62196_T1' {
  const map: Record<
    string,
    'IEC_62196_T2_COMBO' | 'IEC_62196_T1_COMBO' | 'CHADEMO' | 'IEC_62196_T2' | 'IEC_62196_T1'
  > = {
    CCS2: 'IEC_62196_T2_COMBO',
    CCS1: 'IEC_62196_T1_COMBO',
    CHAdeMO: 'CHADEMO',
    Type2: 'IEC_62196_T2',
    Type1: 'IEC_62196_T1',
  };
  if (connectorType == null) return 'IEC_62196_T2';
  return map[connectorType] ?? 'IEC_62196_T2';
}

function inferPowerType(connectorType: string | null): 'DC' | 'AC_3_PHASE' {
  if (connectorType == null) return 'AC_3_PHASE';
  const dcTypes = new Set(['CCS2', 'CCS1', 'CHAdeMO', 'GBT', 'Tesla', 'NACS']);
  return dcTypes.has(connectorType) ? 'DC' : 'AC_3_PHASE';
}

function inferConnectorFormat(connectorType: string | null): 'CABLE' | 'SOCKET' {
  if (connectorType == null) return 'CABLE';
  const dcTypes = new Set(['CCS2', 'CCS1', 'CHAdeMO', 'GBT', 'Tesla', 'NACS']);
  return dcTypes.has(connectorType) ? 'CABLE' : 'SOCKET';
}

export function transformCdr(input: CdrTransformInput, version: OcpiVersion): OcpiCdr {
  const { session, location, countryCode, partyId, cdrId } = input;

  const totalEnergy = whToKwh(session.energyDeliveredWh);
  const currency = session.currency;

  const volumes = {
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    kwh: totalEnergy,
    idleMinutes: session.idleMinutes,
  };
  const times = sessionTimes(volumes);

  const cdrLocation: OcpiCdrLocation = {
    id: location.locationId,
    name: location.siteName,
    address: location.address ?? 'Unknown',
    city: location.city ?? 'Unknown',
    country: location.country ?? 'US',
    coordinates: {
      latitude: location.latitude ?? '0',
      longitude: location.longitude ?? '0',
    },
    evse_uid: location.evseUid,
    evse_id: location.evseId,
    connector_id: location.connectorId,
    connector_standard: mapConnectorStandard(location.connectorType),
    connector_format: inferConnectorFormat(location.connectorType),
    connector_power_type: inferPowerType(location.connectorType),
  };

  if (location.postalCode != null) {
    cdrLocation.postal_code = location.postalCode;
  }
  if (location.state != null) {
    cdrLocation.state = location.state;
  }

  const cdr: OcpiCdr = {
    country_code: countryCode,
    party_id: partyId,
    id: cdrId,
    start_date_time: session.startedAt.toISOString(),
    end_date_time: session.endedAt.toISOString(),
    session_id: session.transactionId,
    cdr_token: cdrToken(input.token),
    auth_method: 'AUTH_REQUEST',
    cdr_location: cdrLocation,
    currency,
    charging_periods: chargingPeriods(volumes),
    total_cost: toOcpiPrice(input.cost.total, version),
    total_energy: totalEnergy,
    total_time: times.totalHours,
    last_updated: session.endedAt.toISOString(),
  };

  // Dimension costs (all Price, optional): fixed is the session fee, parking
  // the idle fee, reservation the reservation holding fee.
  const { cost } = input;
  if (cost.fixed != null) cdr.total_fixed_cost = toOcpiPrice(cost.fixed, version);
  if (cost.energy != null) cdr.total_energy_cost = toOcpiPrice(cost.energy, version);
  if (cost.time != null) cdr.total_time_cost = toOcpiPrice(cost.time, version);
  if (times.parkingHours > 0) cdr.total_parking_time = times.parkingHours;
  if (cost.parking != null) cdr.total_parking_cost = toOcpiPrice(cost.parking, version);
  if (cost.reservation != null) {
    cdr.total_reservation_cost = toOcpiPrice(cost.reservation, version);
  }

  if (input.tariff != null) {
    cdr.tariffs = [input.tariff as OcpiTariff];
  }

  return cdr;
}
