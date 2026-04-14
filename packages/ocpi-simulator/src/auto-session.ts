// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * CPO auto-session loop.
 *
 * When OCPI_SIM_AUTO_SESSION=true and the simulator runs as CPO, this module
 * pushes a location once at startup, then on each interval:
 *   1. Pushes an ACTIVE session to the eMSP sessions receiver
 *   2. Waits OCPI_SIM_SESSION_DURATION seconds
 *   3. Pushes a COMPLETED session update
 *   4. POSTs a CDR to the eMSP CDR receiver
 *
 * No OCPP station is required. This exercises only the eMSP receiver stack.
 */

import { state, findPartnerEndpoint } from './state.js';
import { ocpiPut, ocpiPost } from './client.js';

export const AUTO_SESSION = process.env['OCPI_SIM_AUTO_SESSION'] === 'true';
const INTERVAL_SECONDS = Number(process.env['OCPI_SIM_SESSION_INTERVAL'] ?? 60);
const DURATION_SECONDS = Number(process.env['OCPI_SIM_SESSION_DURATION'] ?? 30);

let running = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;

function locationId(): string {
  return `${state.countryCode}-${state.partyId}-LOC001`;
}

function evseUid(): string {
  return `${locationId()}-EVSE1`;
}

async function pushLocation(): Promise<void> {
  const url = findPartnerEndpoint('locations', 'RECEIVER');
  if (url == null) {
    console.error(
      '[auto-session] eMSP locations receiver endpoint not found, skipping initial location push',
    );
    return;
  }

  const locId = locationId();
  const location = {
    country_code: state.countryCode,
    party_id: state.partyId,
    id: locId,
    publish: true,
    name: `${state.name} Test Location`,
    address: '1 Simulator Street',
    city: 'Simville',
    country: state.countryCode,
    coordinates: { latitude: '52.3676', longitude: '4.9041' },
    time_zone: 'Europe/Amsterdam',
    evses: [
      {
        uid: evseUid(),
        evse_id: `${state.countryCode}*${state.partyId}*E001`,
        status: 'AVAILABLE',
        connectors: [
          {
            id: '1',
            standard: 'IEC_62196_T2_COMBO',
            format: 'CABLE',
            power_type: 'DC',
            max_voltage: 400,
            max_amperage: 125,
            last_updated: new Date().toISOString(),
          },
        ],
        last_updated: new Date().toISOString(),
      },
    ],
    last_updated: new Date().toISOString(),
  };

  await ocpiPut(`${url}/${state.countryCode}/${state.partyId}/${locId}`, location);
  console.log(`[auto-session] Pushed location ${locId}`);
}

async function runSession(): Promise<void> {
  const sessionsUrl = findPartnerEndpoint('sessions', 'RECEIVER');
  const cdrsUrl = findPartnerEndpoint('cdrs', 'RECEIVER');

  if (sessionsUrl == null) {
    console.error('[auto-session] eMSP sessions receiver endpoint not found');
    return;
  }
  if (cdrsUrl == null) {
    console.error('[auto-session] eMSP CDRs receiver endpoint not found');
    return;
  }

  const sessionId = `SIM-SESSION-${Date.now().toString()}`;
  const startTime = new Date();
  const locId = locationId();
  const eu = evseUid();

  // Push ACTIVE session
  const sessionUrl = `${sessionsUrl}/${state.countryCode}/${state.partyId}/${sessionId}`;
  await ocpiPut(sessionUrl, {
    country_code: state.countryCode,
    party_id: state.partyId,
    id: sessionId,
    start_date_time: startTime.toISOString(),
    kwh: 0,
    cdr_token: {
      uid: state.testTokenUid,
      type: 'RFID',
      contract_id: `${state.countryCode}-SIM-${state.testTokenUid}`,
    },
    auth_method: 'WHITELIST',
    location_id: locId,
    evse_uid: eu,
    connector_id: '1',
    currency: 'USD',
    status: 'ACTIVE',
    last_updated: new Date().toISOString(),
  });
  console.log(`[auto-session] Session ${sessionId} ACTIVE`);

  // Wait for session to "complete"
  await new Promise<void>((resolve) => {
    setTimeout(resolve, DURATION_SECONDS * 1000);
  });

  if (!running) return;

  // Calculate totals based on elapsed time
  const endTime = new Date();
  const durationHours = (endTime.getTime() - startTime.getTime()) / 3_600_000;
  const totalKwh = Number((22 * durationHours).toFixed(3)); // 22 kW charger
  const totalCost = Number((totalKwh * 0.35).toFixed(2)); // $0.35/kWh

  // Push COMPLETED session
  await ocpiPut(sessionUrl, {
    country_code: state.countryCode,
    party_id: state.partyId,
    id: sessionId,
    start_date_time: startTime.toISOString(),
    kwh: totalKwh,
    cdr_token: {
      uid: state.testTokenUid,
      type: 'RFID',
      contract_id: `${state.countryCode}-SIM-${state.testTokenUid}`,
    },
    auth_method: 'WHITELIST',
    location_id: locId,
    evse_uid: eu,
    connector_id: '1',
    currency: 'USD',
    status: 'COMPLETED',
    last_updated: endTime.toISOString(),
  });
  console.log(`[auto-session] Session ${sessionId} COMPLETED (${String(totalKwh)} kWh)`);

  // Push CDR
  const cdrId = `SIM-CDR-${Date.now().toString()}`;
  await ocpiPost(cdrsUrl, {
    country_code: state.countryCode,
    party_id: state.partyId,
    id: cdrId,
    start_date_time: startTime.toISOString(),
    end_date_time: endTime.toISOString(),
    cdr_token: {
      uid: state.testTokenUid,
      type: 'RFID',
      contract_id: `${state.countryCode}-SIM-${state.testTokenUid}`,
    },
    auth_method: 'WHITELIST',
    cdr_location: {
      id: locId,
      address: '1 Simulator Street',
      city: 'Simville',
      country: state.countryCode,
      coordinates: { latitude: '52.3676', longitude: '4.9041' },
      evse_uid: eu,
      evse_id: `${state.countryCode}*${state.partyId}*E001`,
      connector_id: '1',
      connector_standard: 'IEC_62196_T2_COMBO',
      connector_format: 'CABLE',
      connector_power_type: 'DC',
    },
    currency: 'USD',
    total_energy: totalKwh,
    total_time: Number(durationHours.toFixed(4)),
    total_cost: { excl_vat: String(totalCost) },
    last_updated: endTime.toISOString(),
  });
  console.log(`[auto-session] CDR ${cdrId} pushed ($${String(totalCost)} USD)`);
}

async function loop(): Promise<void> {
  if (!running) return;

  try {
    await runSession();
  } catch (err) {
    console.error('[auto-session] Session error:', err);
  }

  loopTimer = setTimeout(() => {
    void loop();
  }, INTERVAL_SECONDS * 1000);
}

export async function startAutoSessionLoop(): Promise<void> {
  if (!AUTO_SESSION) return;
  if (state.role !== 'cpo') {
    console.warn('[auto-session] OCPI_SIM_AUTO_SESSION=true but role is not CPO, skipping');
    return;
  }

  running = true;
  console.log(
    `[auto-session] Starting CPO auto-session loop ` +
      `(interval=${String(INTERVAL_SECONDS)}s, duration=${String(DURATION_SECONDS)}s)`,
  );

  try {
    await pushLocation();
  } catch (err) {
    console.error('[auto-session] Failed to push initial location:', err);
  }

  // Start first session immediately
  loopTimer = setTimeout(() => {
    void loop();
  }, 0);
}

export function stopAutoSessionLoop(): void {
  running = false;
  if (loopTimer != null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  console.log('[auto-session] Auto-session loop stopped');
}
