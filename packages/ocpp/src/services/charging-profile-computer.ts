// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Sql } from 'postgres';
import type { PubSubClient } from '@evtivity/lib';
import { publishOcppCommand } from '@evtivity/lib';
import { getDefaultMaxPowerW, operatorStationSql } from '@evtivity/database';
import type { ChargingNeedsProfilePayload, StoredChargingNeedsProfile } from './charging-needs.js';

interface ChargingNeedsInput {
  stationUuid: string;
  stationOcppId: string;
  evseId: number;
  /** The transaction the TxProfile applies to (K15.FR.07, K01.FR.03). */
  transactionId: string;
  chargingNeeds: Record<string, unknown>;
  maxScheduleTuples?: number | null;
}

interface ChargingSchedulePeriod {
  startPeriod: number;
  limit: number;
}

/** The default number of periods when the EV sends no maxScheduleTuples. */
const DEFAULT_MAX_SCHEDULE_TUPLES = 24;

/** Smallest remaining time the departure-based rate divides by (60 s). */
const MIN_REMAINING_SECONDS = 60;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function params(needs: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = needs[key];
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * The most power the EV accepts, in W, from its charging needs. ISO 15118-20
 * (v2xChargingParameters.maxChargePower) wins over the ISO 15118-2 AC and DC
 * parameters. AC power is current times voltage, per phase.
 */
export function evMaxPowerW(needs: Record<string, unknown>, fallbackW: number): number {
  const v2x = params(needs, 'v2xChargingParameters');
  const v2xMax = num(v2x?.maxChargePower);
  if (v2xMax != null) return v2xMax;

  const requested =
    typeof needs.requestedEnergyTransfer === 'string' ? needs.requestedEnergyTransfer : '';
  const dc = params(needs, 'dcChargingParameters');
  if (requested.startsWith('DC') && dc != null) {
    const maxPower = num(dc.evMaxPower);
    if (maxPower != null) return maxPower;
    const current = num(dc.evMaxCurrent);
    const voltage = num(dc.evMaxVoltage);
    if (current != null && voltage != null) return current * voltage;
    return fallbackW;
  }

  const ac = params(needs, 'acChargingParameters');
  if (ac != null) {
    const current = num(ac.evMaxCurrent);
    const voltage = num(ac.evMaxVoltage);
    if (current != null && voltage != null) {
      return current * voltage * (requested === 'AC_three_phase' ? 3 : 1);
    }
  }
  return fallbackW;
}

/**
 * The energy the EV asks for, in Wh: energyAmount of the ISO 15118-2 AC or DC
 * parameters, or evTargetEnergyRequest of the ISO 15118-20 parameters.
 */
export function requestedEnergyWh(needs: Record<string, unknown>): number | null {
  const candidates = [
    num(params(needs, 'acChargingParameters')?.energyAmount),
    num(params(needs, 'dcChargingParameters')?.energyAmount),
    num(params(needs, 'v2xChargingParameters')?.evTargetEnergyRequest),
  ];
  return candidates.find((v) => v != null && v > 0) ?? null;
}

/**
 * A stable charging profile id for the TxProfile of one transaction. A
 * renegotiation (K16, K17) sends the profile again with the same id, so the
 * station replaces it (K01.FR.05) instead of refusing a second profile with
 * the same stackLevel and transactionId (K01.FR.39). The id stays in the upper
 * half of the int32 range, away from the small ids of templates and load
 * management.
 */
export function chargingNeedsProfileId(stationOcppId: string, transactionId: string): number {
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (const ch of `${stationOcppId}:${transactionId}`) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const half = 0x40000000;
  return half + (hash % (0x7fffffff - half));
}

/**
 * The schedule limit in W: the lower of what the EV accepts, the connector and
 * the site headroom, and, when the EV gave a departure time and an energy
 * amount, the rate that delivers that energy by the departure time.
 */
export function scheduleLimitW(input: {
  evMaxW: number;
  connectorMaxW: number | null;
  siteAvailableW: number | null;
  energyWh: number | null;
  departureTime: string | null;
  now: Date;
}): number {
  let limit = input.evMaxW;
  if (input.connectorMaxW != null) limit = Math.min(limit, input.connectorMaxW);
  if (input.siteAvailableW != null) limit = Math.min(limit, input.siteAvailableW);
  if (input.departureTime != null && input.energyWh != null) {
    const departure = new Date(input.departureTime).getTime();
    if (Number.isFinite(departure)) {
      const remainingSeconds = Math.max(
        MIN_REMAINING_SECONDS,
        (departure - input.now.getTime()) / 1000,
      );
      limit = Math.min(limit, input.energyWh / (remainingSeconds / 3600));
    }
  }
  return Math.max(0, Math.round(limit));
}

export async function computeAndSendChargingProfile(
  sql: Sql,
  pubsub: PubSubClient,
  input: ChargingNeedsInput,
  now: Date = new Date(),
): Promise<void> {
  const { stationUuid, stationOcppId, evseId, transactionId, chargingNeeds, maxScheduleTuples } =
    input;

  const evMaxW = evMaxPowerW(chargingNeeds, await getDefaultMaxPowerW());

  // Connector limit of the EVSE.
  let connectorMaxW: number | null = null;
  const connectorRows = await sql`
    SELECT max(c.max_power_kw) AS max_power_kw FROM connectors c
    JOIN evses e ON c.evse_id = e.id
    WHERE e.station_id = ${stationUuid} AND e.evse_id = ${evseId}
  `;
  if (connectorRows[0]?.max_power_kw != null) {
    connectorMaxW = Number(connectorRows[0].max_power_kw) * 1000;
  }

  // Site headroom when the site has an enabled power limit: the limit minus
  // the latest power reading of every other active session at the same site.
  // Sessions at conformance test stations do not count against the limit.
  let siteAvailableW: number | null = null;
  const siteRows = await sql`
    SELECT spl.max_power_kw, cs.site_id
    FROM charging_stations cs
    JOIN site_power_limits spl ON spl.site_id = cs.site_id
    WHERE cs.id = ${stationUuid} AND spl.is_enabled = true
    LIMIT 1
  `;
  if (siteRows[0]?.max_power_kw != null) {
    const siteMaxW = Number(siteRows[0].max_power_kw) * 1000;
    const siteId = siteRows[0].site_id as string;
    const drawRows = await sql`
      SELECT COALESCE(SUM(latest.value_w), 0) AS current_draw
      FROM (
        SELECT DISTINCT ON (mv.session_id)
          CASE WHEN mv.unit = 'kW' THEN mv.value * 1000 ELSE mv.value END AS value_w
        FROM meter_values mv
        JOIN charging_sessions s ON s.id = mv.session_id
        JOIN charging_stations st ON st.id = s.station_id
        WHERE st.site_id = ${siteId}
          AND s.station_id <> ${stationUuid}
          AND ${sql.unsafe(operatorStationSql('st'))}
          AND s.status = 'active'
          AND mv.measurand = 'Power.Active.Import'
          AND mv.phase IS NULL
          AND mv.timestamp > now() - interval '5 minutes'
        ORDER BY mv.session_id, mv.timestamp DESC
      ) latest
    `;
    siteAvailableW = Math.max(0, siteMaxW - Number(drawRows[0]?.current_draw ?? 0));
  }

  const departureTime =
    typeof chargingNeeds.departureTime === 'string' ? chargingNeeds.departureTime : null;
  const limit = scheduleLimitW({
    evMaxW,
    connectorMaxW,
    siteAvailableW,
    energyWh: requestedEnergyWh(chargingNeeds),
    departureTime,
    now,
  });

  // One period now; maxScheduleTuples (at least 1) bounds the periods.
  const periods: ChargingSchedulePeriod[] = [{ startPeriod: 0, limit }].slice(
    0,
    Math.max(1, maxScheduleTuples ?? DEFAULT_MAX_SCHEDULE_TUPLES),
  );

  const profileId = chargingNeedsProfileId(stationOcppId, transactionId);
  const chargingSchedule = {
    id: profileId,
    // K01.FR.40: an Absolute profile carries startSchedule.
    startSchedule: now.toISOString(),
    chargingRateUnit: 'W',
    chargingSchedulePeriod: periods,
  };

  // K15.FR.07 / K17.FR.07 / K18.FR.07: a TxProfile for the transaction, with
  // one chargingSchedule (K15.FR.18).
  const payload: ChargingNeedsProfilePayload = {
    evseId,
    chargingProfile: {
      id: profileId,
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      transactionId,
      chargingSchedule: [chargingSchedule],
    },
  };

  // Stored before the send, so the EV schedule the station reports back is
  // checked against it (K15.FR.11/12) even when the send is slow.
  const stored: StoredChargingNeedsProfile = { payload, renegotiations: 0 };
  await sql`
    UPDATE ev_charging_needs SET csms_charging_profile = ${sql.json(stored as never)}
    WHERE station_id = ${stationUuid} AND evse_id = ${evseId}
  `;

  await publishOcppCommand(pubsub, {
    stationId: stationOcppId,
    action: 'SetChargingProfile',
    payload: payload as unknown as Record<string, unknown>,
  });
}

/** Renegotiations the CSMS starts for one profile before it gives up. */
export const MAX_SCHEDULE_RENEGOTIATIONS = 1;

/**
 * Starts a renegotiation after the EV reported a schedule outside the CSMS
 * limits (K15.FR.13, K16.FR.08): sends the stored TxProfile again, which makes
 * the station renegotiate with the EV (K16.FR.01, K16.FR.02). At most
 * MAX_SCHEDULE_RENEGOTIATIONS times per profile, so an EV that keeps exceeding
 * the limit does not loop. Returns whether it sent the profile.
 */
export async function renegotiateChargingNeedsProfile(
  sql: Sql,
  pubsub: PubSubClient,
  input: { stationUuid: string; stationOcppId: string; evseId: number },
): Promise<boolean> {
  const rows = await sql`
    UPDATE ev_charging_needs
    SET csms_charging_profile = jsonb_set(
      csms_charging_profile, '{renegotiations}',
      to_jsonb(COALESCE((csms_charging_profile->>'renegotiations')::int, 0) + 1)
    )
    WHERE station_id = ${input.stationUuid} AND evse_id = ${input.evseId}
      AND csms_charging_profile IS NOT NULL
      AND COALESCE((csms_charging_profile->>'renegotiations')::int, 0) < ${MAX_SCHEDULE_RENEGOTIATIONS}
    RETURNING csms_charging_profile
  `;
  const stored = rows[0]?.csms_charging_profile as StoredChargingNeedsProfile | undefined;
  if (stored?.payload == null) return false;
  await publishOcppCommand(pubsub, {
    stationId: input.stationOcppId,
    action: 'SetChargingProfile',
    payload: stored.payload as unknown as Record<string, unknown>,
  });
  return true;
}
