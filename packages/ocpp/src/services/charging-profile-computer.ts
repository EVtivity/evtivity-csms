// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Sql } from 'postgres';
import type { PubSubClient } from '@evtivity/lib';
import crypto from 'node:crypto';

interface ChargingNeedsInput {
  stationUuid: string;
  stationOcppId: string;
  evseId: number;
  chargingNeeds: Record<string, unknown>;
  maxScheduleTuples?: number | null;
}

interface ChargingSchedulePeriod {
  startPeriod: number;
  limit: number;
}

interface ChargingSchedule {
  id: number;
  chargingRateUnit: string;
  chargingSchedulePeriod: ChargingSchedulePeriod[];
}

interface ChargingProfile {
  id: number;
  stackLevel: number;
  chargingProfilePurpose: string;
  chargingProfileKind: string;
  chargingSchedule: ChargingSchedule[];
}

export async function computeAndSendChargingProfile(
  sql: Sql,
  pubsub: PubSubClient,
  input: ChargingNeedsInput,
): Promise<void> {
  const { stationUuid, stationOcppId, evseId, chargingNeeds, maxScheduleTuples } = input;

  // 1. Extract EV parameters
  const requestedEnergyTransfer =
    (chargingNeeds.requestedEnergyTransfer as string | undefined) ?? 'AC_single_phase';
  const acParams = chargingNeeds.acChargingParameters as Record<string, unknown> | undefined;
  const dcParams = chargingNeeds.dcChargingParameters as Record<string, unknown> | undefined;
  const v2xParams = chargingNeeds.v2xChargingParameters as Record<string, unknown> | undefined;
  const departureTime = (chargingNeeds.departureTime as string | undefined) ?? null;
  const energyAmount = (chargingNeeds.energyAmount as number | undefined) ?? null;

  // 2. Calculate EV max power acceptance (W)
  let evMaxPowerW = 22000; // fallback

  if (requestedEnergyTransfer.startsWith('DC')) {
    if (dcParams != null) {
      const evMaxPower = dcParams.evMaxPower as number | undefined;
      const evMaxCurrent = dcParams.evMaxCurrent as number | undefined;
      const evMaxVoltage = dcParams.evMaxVoltage as number | undefined;
      if (evMaxPower != null) {
        evMaxPowerW = evMaxPower;
      } else if (evMaxCurrent != null && evMaxVoltage != null) {
        evMaxPowerW = evMaxCurrent * evMaxVoltage;
      }
    }
    if (v2xParams != null) {
      const evMaxPower = v2xParams.evMaxChargePower as number | undefined;
      if (evMaxPower != null) evMaxPowerW = evMaxPower;
    }
  } else if (requestedEnergyTransfer === 'AC_three_phase') {
    if (acParams != null) {
      const evMaxCurrent = (acParams.evMaxCurrent as number | undefined) ?? 32;
      const evMaxVoltage = (acParams.evMaxVoltage as number | undefined) ?? 230;
      evMaxPowerW = evMaxCurrent * evMaxVoltage * 3;
    }
  } else {
    // AC_single_phase or default
    if (acParams != null) {
      const evMaxCurrent = (acParams.evMaxCurrent as number | undefined) ?? 32;
      const evMaxVoltage = (acParams.evMaxVoltage as number | undefined) ?? 230;
      evMaxPowerW = evMaxCurrent * evMaxVoltage;
    }
  }

  // 3. Resolve constraints
  // 3a. Connector max power
  let connectorMaxW = evMaxPowerW;
  const connectorRows = await sql`
    SELECT c.max_power_kw FROM connectors c
    JOIN evses e ON c.evse_id = e.id
    WHERE e.station_id = ${stationUuid} AND e.evse_id = ${evseId}
    LIMIT 1
  `;
  if (connectorRows.length > 0 && connectorRows[0]?.max_power_kw != null) {
    connectorMaxW = Number(connectorRows[0].max_power_kw) * 1000;
  }

  // 3b. Site power limit (if load management enabled)
  let siteAvailableW = evMaxPowerW;
  const siteRows = await sql`
    SELECT spl.max_power_kw
    FROM site_power_limits spl
    JOIN sites s ON s.id = spl.site_id
    JOIN charging_stations cs ON cs.site_id = s.id
    WHERE cs.id = ${stationUuid} AND spl.is_enabled = true
    LIMIT 1
  `;
  if (siteRows.length > 0 && siteRows[0]?.max_power_kw != null) {
    const siteMaxW = Number(siteRows[0].max_power_kw) * 1000;

    // Get current site draw from recent meter values (excluding this station)
    const drawRows = await sql`
      SELECT COALESCE(SUM(mv.value), 0) AS current_draw
      FROM meter_values mv
      JOIN charging_sessions cs ON mv.session_id = cs.id
      WHERE cs.station_id != ${stationUuid}
        AND cs.status = 'active'
        AND mv.measurand = 'Power.Active.Import'
        AND mv.timestamp > NOW() - INTERVAL '5 minutes'
    `;
    const currentDrawW = Number(drawRows[0]?.current_draw ?? 0);
    siteAvailableW = Math.max(0, siteMaxW - currentDrawW);
  }

  // 3c. Determine available power
  const availableW = Math.min(evMaxPowerW, siteAvailableW, connectorMaxW);

  // 4. Build charging schedule
  const periods: ChargingSchedulePeriod[] = [];
  const maxTuples = maxScheduleTuples ?? 24;

  if (departureTime != null && energyAmount != null && energyAmount > 0) {
    // Compute required power rate
    const departureDate = new Date(departureTime);
    const now = new Date();
    const remainingSeconds = Math.max(60, (departureDate.getTime() - now.getTime()) / 1000);
    const remainingHours = remainingSeconds / 3600;
    const requiredPowerW = energyAmount / remainingHours; // energyAmount is in Wh, result is in W

    // Use the lesser of required and available
    const limitW = Math.min(requiredPowerW, availableW);
    periods.push({ startPeriod: 0, limit: Math.round(limitW) });
  } else {
    // Single flat limit at available power
    periods.push({ startPeriod: 0, limit: Math.round(availableW) });
  }

  // Enforce maxScheduleTuples
  const trimmedPeriods = periods.slice(0, maxTuples);

  // 5. Build and send the profile
  const profileId = Math.floor(Math.random() * 2_147_483_647);
  const profile: ChargingProfile = {
    id: profileId,
    stackLevel: 1,
    chargingProfilePurpose: 'TxProfile',
    chargingProfileKind: 'Absolute',
    chargingSchedule: [
      {
        id: profileId + 1,
        chargingRateUnit: 'W',
        chargingSchedulePeriod: trimmedPeriods,
      },
    ],
  };

  const commandPayload = {
    commandId: crypto.randomUUID(),
    stationId: stationOcppId,
    action: 'SetChargingProfile',
    payload: {
      evseId,
      chargingProfile: profile,
    },
  };

  await pubsub.publish('ocpp_commands', JSON.stringify(commandPayload));

  // 6. Record computed schedule
  await sql`
    INSERT INTO ev_charging_schedules (station_id, evse_id, charging_schedule)
    VALUES (${stationUuid}, ${evseId}, ${JSON.stringify(profile.chargingSchedule)}::jsonb)
  `;
}
