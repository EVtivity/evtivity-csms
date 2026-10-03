// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Volumes and charging periods shared by OCPI Sessions and CDRs.

import type { OcpiChargingPeriod, OcpiCdrToken, OcpiTokenType } from '../types/ocpi.js';

const OCPI_DECIMALS = 10_000;

function round4(value: number): number {
  return Math.round(value * OCPI_DECIMALS) / OCPI_DECIMALS;
}

/** Wh (as stored) in kWh, 4 decimals. */
export function whToKwh(wh: string | null): number {
  if (wh == null) return 0;
  const parsed = parseFloat(wh);
  if (isNaN(parsed)) return 0;
  return round4(parsed / 1000);
}

/** Hours between two instants, 4 decimals. */
export function hoursBetween(start: Date, end: Date): number {
  return round4(Math.max(0, end.getTime() - start.getTime()) / 3_600_000);
}

export interface SessionVolumes {
  startedAt: Date;
  /** The session end, or the time the volumes were read for a running session. */
  endedAt: Date;
  kwh: number;
  /** Minutes the EV was connected without charging (the session idle minutes). */
  idleMinutes: number;
}

export interface SessionTimes {
  totalHours: number;
  parkingHours: number;
  chargingHours: number;
}

export function sessionTimes(volumes: SessionVolumes): SessionTimes {
  const totalHours = hoursBetween(volumes.startedAt, volumes.endedAt);
  const parkingHours = Math.min(totalHours, round4(Math.max(0, volumes.idleMinutes) / 60));
  return { totalHours, parkingHours, chargingHours: round4(totalHours - parkingHours) };
}

/**
 * The charging periods of a session: one period with the energy and the
 * charging time (TIME, "time charging"), and, when the EV was connected
 * without charging, a period with that time as PARKING_TIME ("time not
 * charging"). Only the accumulated idle minutes are stored, not when each idle
 * stretch happened, so the parking period starts after the charging time.
 */
export function chargingPeriods(volumes: SessionVolumes): OcpiChargingPeriod[] {
  const times = sessionTimes(volumes);
  const periods: OcpiChargingPeriod[] = [
    {
      start_date_time: volumes.startedAt.toISOString(),
      dimensions: [
        { type: 'ENERGY', volume: volumes.kwh },
        { type: 'TIME', volume: times.chargingHours },
      ],
    },
  ];
  if (times.parkingHours > 0) {
    const parkingStart = new Date(volumes.startedAt.getTime() + times.chargingHours * 3_600_000);
    periods.push({
      start_date_time: parkingStart.toISOString(),
      dimensions: [{ type: 'PARKING_TIME', volume: times.parkingHours }],
    });
  }
  return periods;
}

const TOKEN_TYPES: ReadonlySet<string> = new Set<OcpiTokenType>([
  'AD_HOC_USER',
  'APP_USER',
  'OTHER',
  'RFID',
]);

/** The partner's token that started a session, as stored in ocpi_external_tokens. */
export interface CdrTokenSource {
  uid: string;
  countryCode: string;
  partyId: string;
  tokenType?: string | null;
  contractId?: string | null;
}

/** The CdrToken of a partner's token (type RFID and contract_id = uid when unknown). */
export function cdrToken(token: CdrTokenSource): OcpiCdrToken {
  const type =
    token.tokenType != null && TOKEN_TYPES.has(token.tokenType)
      ? (token.tokenType as OcpiTokenType)
      : 'RFID';
  return {
    country_code: token.countryCode,
    party_id: token.partyId,
    uid: token.uid,
    type,
    contract_id: token.contractId ?? token.uid,
  };
}
