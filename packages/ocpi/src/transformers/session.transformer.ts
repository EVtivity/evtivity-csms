// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  OcpiSession,
  OcpiSessionStatus,
  OcpiChargingPeriod,
  OcpiCdrToken,
  OcpiVersion,
} from '../types/ocpi.js';

interface SessionRow {
  id: string;
  transactionId: string;
  status: 'active' | 'completed' | 'invalid' | 'faulted';
  startedAt: Date | null;
  endedAt: Date | null;
  energyDeliveredWh: string | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  currency: string | null;
}

interface SessionTransformInput {
  session: SessionRow;
  countryCode: string;
  partyId: string;
  locationId: string;
  evseUid: string;
  connectorId: string;
  tokenUid: string;
  tokenCountryCode: string;
  tokenPartyId: string;
}

const SESSION_STATUS_MAP: Record<string, OcpiSessionStatus> = {
  active: 'ACTIVE',
  completed: 'COMPLETED',
  invalid: 'INVALID',
  faulted: 'INVALID',
};

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

export function transformSession(input: SessionTransformInput, version: OcpiVersion): OcpiSession {
  const { session, countryCode, partyId, locationId, evseUid, connectorId } = input;

  const kwh = whToKwh(session.energyDeliveredWh);
  const status = SESSION_STATUS_MAP[session.status] ?? 'ACTIVE';

  const costCents =
    session.status === 'completed' ? session.finalCostCents : session.currentCostCents;
  const costValue = centsToCost(costCents);
  const currency = session.currency ?? 'USD';

  const cdrToken: OcpiCdrToken = {
    country_code: input.tokenCountryCode,
    party_id: input.tokenPartyId,
    uid: input.tokenUid,
    type: 'RFID',
    contract_id: input.tokenUid,
  };

  const chargingPeriods: OcpiChargingPeriod[] = [];
  if (session.startedAt != null) {
    chargingPeriods.push({
      start_date_time: session.startedAt.toISOString(),
      dimensions: [
        { type: 'ENERGY', volume: kwh },
        {
          type: 'TIME',
          volume: getSessionDurationHours(session.startedAt, session.endedAt),
        },
      ],
    });
  }

  const result: OcpiSession = {
    country_code: countryCode,
    party_id: partyId,
    id: session.transactionId,
    start_date_time: session.startedAt?.toISOString() ?? new Date().toISOString(),
    kwh,
    cdr_token: cdrToken,
    auth_method: 'AUTH_REQUEST',
    location_id: locationId,
    evse_uid: evseUid,
    connector_id: connectorId,
    currency,
    charging_periods: chargingPeriods,
    total_cost: { excl_vat: costValue },
    status,
    last_updated: (session.endedAt ?? session.startedAt ?? new Date()).toISOString(),
  };

  if (session.endedAt != null) {
    result.end_date_time = session.endedAt.toISOString();
  }

  if (version === '2.3.0') {
    // 2.3.0-specific session fields will be added here
  }

  return result;
}

function getSessionDurationHours(startedAt: Date, endedAt: Date | null): number {
  const end = endedAt ?? new Date();
  const durationMs = end.getTime() - startedAt.getTime();
  return Math.round((durationMs / 3600000) * 10000) / 10000;
}
