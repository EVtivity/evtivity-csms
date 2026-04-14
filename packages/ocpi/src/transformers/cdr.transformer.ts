// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  OcpiCdr,
  OcpiCdrLocation,
  OcpiCdrToken,
  OcpiChargingPeriod,
  OcpiTariff,
  OcpiVersion,
} from '../types/ocpi.js';

interface CdrInput {
  sessionId: string;
  transactionId: string;
  startedAt: Date;
  endedAt: Date;
  energyDeliveredWh: string | null;
  finalCostCents: number | null;
  currency: string | null;
}

interface CdrLocationInput {
  siteId: string;
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
  location: CdrLocationInput;
  countryCode: string;
  partyId: string;
  cdrId: string;
  tokenUid: string;
  tokenCountryCode: string;
  tokenPartyId: string;
  tariff?: OcpiTariff;
}

function whToKwh(wh: string | null): number {
  if (wh == null) return 0;
  const parsed = parseFloat(wh);
  if (isNaN(parsed)) return 0;
  return Math.round((parsed / 1000) * 10000) / 10000;
}

function centsToCost(cents: number | null): number {
  if (cents == null) return 0;
  return cents / 100;
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
  const totalCost = centsToCost(session.finalCostCents);
  const currency = session.currency ?? 'USD';

  const durationMs = session.endedAt.getTime() - session.startedAt.getTime();
  const totalTimeHours = Math.round((durationMs / 3600000) * 10000) / 10000;

  const cdrToken: OcpiCdrToken = {
    country_code: input.tokenCountryCode,
    party_id: input.tokenPartyId,
    uid: input.tokenUid,
    type: 'RFID',
    contract_id: input.tokenUid,
  };

  const cdrLocation: OcpiCdrLocation = {
    id: location.siteId,
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

  const chargingPeriods: OcpiChargingPeriod[] = [
    {
      start_date_time: session.startedAt.toISOString(),
      dimensions: [
        { type: 'ENERGY', volume: totalEnergy },
        { type: 'TIME', volume: totalTimeHours },
      ],
    },
  ];

  const cdr: OcpiCdr = {
    country_code: countryCode,
    party_id: partyId,
    id: cdrId,
    start_date_time: session.startedAt.toISOString(),
    end_date_time: session.endedAt.toISOString(),
    session_id: session.transactionId,
    cdr_token: cdrToken,
    auth_method: 'AUTH_REQUEST',
    cdr_location: cdrLocation,
    currency,
    charging_periods: chargingPeriods,
    total_cost: { excl_vat: totalCost },
    total_energy: totalEnergy,
    total_time: totalTimeHours,
    last_updated: session.endedAt.toISOString(),
  };

  if (input.tariff != null) {
    cdr.tariffs = [input.tariff];
  }

  if (version === '2.3.0') {
    // 2.3.0-specific CDR fields (AFIR, parking, NA tax) will be added here
  }

  return cdr;
}
