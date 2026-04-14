// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppClient } from '@evtivity/css/ocpp-client';
import type { OcppTestServer } from './cs-server.js';

/**
 * Execute the "Booted" reusable state.
 * The station sends BootNotification, server responds Accepted,
 * station sends StatusNotification for all connectors.
 */
export async function bootStation(
  server: OcppTestServer,
  client: OcppClient,
  options?: { evseCount?: number; status?: string },
): Promise<Record<string, unknown>> {
  // Station sends BootNotification
  const bootResponse = await client.sendCall('BootNotification', {
    chargingStation: {
      model: 'OCTT-Virtual',
      vendorName: 'OCTT',
      serialNumber: 'OCTT-SN-001',
      firmwareVersion: '1.0.0',
    },
    reason: 'PowerUp',
  });

  // Wait for StatusNotification(s) from the station
  const evseCount = options?.evseCount ?? 1;
  for (let i = 0; i < evseCount; i++) {
    try {
      await server.waitForMessage('StatusNotification', 5000);
    } catch {
      // Some implementations may not send StatusNotification on boot
      break;
    }
  }

  return bootResponse;
}

/**
 * Execute the "Booted Pending" reusable state.
 * Like bootStation but server responds with Pending first.
 */
export async function bootStationPending(server: OcppTestServer): Promise<void> {
  // Override handler to respond Pending to first BootNotification
  let bootCount = 0;
  const originalHandler = server['messageHandler'];

  server.setMessageHandler(async (action, payload) => {
    if (action === 'BootNotification') {
      bootCount++;
      if (bootCount === 1) {
        return {
          currentTime: new Date().toISOString(),
          interval: 5,
          status: 'Pending',
        };
      }
      return {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: 'Accepted',
      };
    }
    if (originalHandler != null) {
      return originalHandler(action, payload);
    }
    return {};
  });

  // Wait for the first BootNotification (Pending response)
  await server.waitForMessage('BootNotification', 10000);

  // Wait for the retry BootNotification (Accepted response)
  await server.waitForMessage('BootNotification', 15000);

  // Wait for StatusNotification
  try {
    await server.waitForMessage('StatusNotification', 5000);
  } catch {
    // Optional
  }
}

/**
 * Send Authorize request from the station.
 */
export async function authorizeStation(
  client: OcppClient,
  idToken = 'OCTT-TOKEN-001',
  tokenType = 'ISO14443',
): Promise<Record<string, unknown>> {
  if (client.protocol === 'ocpp1.6') {
    return client.sendCall('Authorize', { idTag: idToken });
  }
  return client.sendCall('Authorize', {
    idToken: { idToken, type: tokenType },
  });
}

/**
 * Start a transaction from the station side.
 */
export async function startTransaction(
  client: OcppClient,
  options?: {
    evseId?: number;
    connectorId?: number;
    idToken?: string;
    tokenType?: string;
    transactionId?: string;
  },
): Promise<Record<string, unknown>> {
  const evseId = options?.evseId ?? 1;
  const connectorId = options?.connectorId ?? 1;
  const idToken = options?.idToken ?? 'OCTT-TOKEN-001';
  const tokenType = options?.tokenType ?? 'ISO14443';
  const txId = options?.transactionId ?? `TX-${Math.random().toString(36).slice(2, 10)}`;

  if (client.protocol === 'ocpp1.6') {
    return client.sendCall('StartTransaction', {
      connectorId,
      idTag: idToken,
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
  }

  return client.sendCall('TransactionEvent', {
    eventType: 'Started',
    timestamp: new Date().toISOString(),
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: {
      transactionId: txId,
      chargingState: 'EVConnected',
    },
    evse: { id: evseId, connectorId },
    idToken: { idToken, type: tokenType },
  });
}

/**
 * Stop a transaction from the station side.
 */
export async function stopTransaction(
  client: OcppClient,
  options?: {
    transactionId?: string;
    meterStop?: number;
    reason?: string;
  },
): Promise<Record<string, unknown>> {
  if (client.protocol === 'ocpp1.6') {
    return client.sendCall('StopTransaction', {
      transactionId: 1,
      meterStop: options?.meterStop ?? 1000,
      timestamp: new Date().toISOString(),
      reason: options?.reason ?? 'Local',
    });
  }

  return client.sendCall('TransactionEvent', {
    eventType: 'Ended',
    timestamp: new Date().toISOString(),
    triggerReason: options?.reason ?? 'StopAuthorized',
    seqNo: 1,
    transactionInfo: {
      transactionId: options?.transactionId ?? 'TX-001',
      stoppedReason: options?.reason ?? 'Local',
    },
  });
}

/**
 * Send StatusNotification from the station.
 */
export async function sendStatusNotification(
  client: OcppClient,
  options?: {
    evseId?: number;
    connectorId?: number;
    status?: string;
  },
): Promise<Record<string, unknown>> {
  const evseId = options?.evseId ?? 1;
  const connectorId = options?.connectorId ?? 1;
  const status = options?.status ?? 'Available';

  if (client.protocol === 'ocpp1.6') {
    return client.sendCall('StatusNotification', {
      connectorId,
      status,
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
  }

  return client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: status,
    evseId,
    connectorId,
  });
}

/**
 * Send Heartbeat from the station.
 */
export async function sendHeartbeat(client: OcppClient): Promise<Record<string, unknown>> {
  return client.sendCall('Heartbeat', {});
}

/**
 * Send MeterValues from the station.
 */
export async function sendMeterValues(
  client: OcppClient,
  options?: {
    evseId?: number;
    connectorId?: number;
    energyWh?: number;
    powerW?: number;
    transactionId?: number;
  },
): Promise<Record<string, unknown>> {
  const evseId = options?.evseId ?? 1;
  const energyWh = options?.energyWh ?? 1000;

  if (client.protocol === 'ocpp1.6') {
    return client.sendCall('MeterValues', {
      connectorId: options?.connectorId ?? 1,
      transactionId: options?.transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: String(energyWh),
              measurand: 'Energy.Active.Import.Register',
              unit: 'Wh',
            },
          ],
        },
      ],
    });
  }

  return client.sendCall('MeterValues', {
    evseId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: energyWh,
            measurand: 'Energy.Active.Import.Register',
            unitOfMeasure: { unit: 'Wh' },
          },
        ],
      },
    ],
  });
}
