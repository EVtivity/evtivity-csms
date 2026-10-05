// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { db } from '@evtivity/database';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';

const STATUS_CHECK_TIMEOUT_MS = 10_000;
const STATUS_POLL_INTERVAL_MS = 500;

export type StatusCheckErrorCode =
  | 'STATION_OFFLINE'
  | 'CONNECTOR_NOT_FOUND'
  | 'STATION_TIMEOUT'
  | 'STATUS_CHECK_REJECTED'
  | 'STATUS_CHECK_TIMEOUT';

export const STATUS_CHECK_ERRORS: Record<
  StatusCheckErrorCode,
  { httpStatus: 400 | 404 | 502 | 504; error: string }
> = {
  STATION_OFFLINE: { httpStatus: 400, error: 'Station is offline' },
  CONNECTOR_NOT_FOUND: { httpStatus: 404, error: 'Connector not found' },
  STATION_TIMEOUT: { httpStatus: 504, error: 'Station did not respond' },
  STATUS_CHECK_REJECTED: { httpStatus: 502, error: 'Station rejected the status check' },
  STATUS_CHECK_TIMEOUT: {
    httpStatus: 504,
    error: 'Status check timed out. Replug the connector and try again.',
  },
};

export async function sendStatusCheckError(
  reply: FastifyReply,
  code: StatusCheckErrorCode,
): Promise<void> {
  const { httpStatus, error } = STATUS_CHECK_ERRORS[code];
  await reply.status(httpStatus).send({ error, code });
}

export type StatusCheckResult =
  | { status: string; errorCode?: undefined }
  | { status: null; errorCode: StatusCheckErrorCode };

export async function triggerAndWaitForStatus(
  stationOcppId: string,
  evseId: number,
  connectorId: number,
  stationDbId: string,
  version?: string,
): Promise<StatusCheckResult> {
  // Read current status + updated_at before triggering
  const before = await db.execute<{ status: string; updated_at: string }>(
    sql`SELECT c.status, c.updated_at
        FROM connectors c
        JOIN evses e ON c.evse_id = e.id
        WHERE e.station_id = ${stationDbId} AND e.evse_id = ${evseId} AND c.connector_id = ${connectorId}`,
  );
  const beforeRow = before[0];
  if (beforeRow == null) {
    return { status: null, errorCode: 'CONNECTOR_NOT_FOUND' };
  }
  const beforeUpdatedAt = new Date(beforeRow.updated_at).getTime();

  // Pick the right TriggerMessage payload:
  //   - OCPP 1.6: StatusNotification (its statuses are already fine-grained:
  //     Charging / Preparing / Finishing / SuspendedEV / SuspendedEVSE).
  //   - OCPP 2.1 with active session: TransactionEvent — its `chargingState`
  //     carries the actual charging activity (StatusNotification on 2.1 only
  //     reports coarse Occupied which is less specific than chargingState).
  //   - OCPP 2.1 without active session: StatusNotification — there's no
  //     transaction to refresh; connector-level state is all the station has.
  let triggerPayload: Record<string, unknown>;
  if (version === 'ocpp1.6') {
    triggerPayload = { requestedMessage: 'StatusNotification', connectorId };
  } else {
    const activeSessionRows = await db.execute<{ id: string }>(
      sql`SELECT cs.id
          FROM charging_sessions cs
          JOIN evses e ON cs.evse_id = e.id
          WHERE e.station_id = ${stationDbId} AND e.evse_id = ${evseId}
            AND cs.status = 'active'
          LIMIT 1`,
    );
    if (activeSessionRows.length > 0) {
      triggerPayload = {
        requestedMessage: 'TransactionEvent',
        evse: { id: evseId, connectorId },
      };
    } else {
      triggerPayload = {
        requestedMessage: 'StatusNotification',
        evse: { id: evseId, connectorId },
      };
    }
  }

  const cmdResult = await sendOcppCommandAndWait(
    stationOcppId,
    'TriggerMessage',
    triggerPayload,
    version,
  );

  if (cmdResult.error != null) {
    return { status: null, errorCode: 'STATION_TIMEOUT' };
  }

  const response = cmdResult.response as { status?: string } | undefined;
  if (response?.status !== 'Accepted' && response?.status !== 'NotImplemented') {
    return { status: null, errorCode: 'STATUS_CHECK_REJECTED' };
  }

  // NotImplemented means the station won't send a StatusNotification, so return the current DB status
  if (response.status === 'NotImplemented') {
    return { status: beforeRow.status };
  }

  // Poll DB for updated connector status (station sends StatusNotification async)
  const deadline = Date.now() + STATUS_CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
    const current = await db.execute<{ status: string; updated_at: string }>(
      sql`SELECT c.status, c.updated_at
          FROM connectors c
          JOIN evses e ON c.evse_id = e.id
          WHERE e.station_id = ${stationDbId} AND e.evse_id = ${evseId} AND c.connector_id = ${connectorId}`,
    );
    const currentRow = current[0];
    if (currentRow != null) {
      const currentUpdatedAt = new Date(currentRow.updated_at).getTime();
      if (currentUpdatedAt > beforeUpdatedAt) {
        return { status: currentRow.status };
      }
    }
  }

  // Timeout: status was not updated within 10s
  return { status: null, errorCode: 'STATUS_CHECK_TIMEOUT' };
}
