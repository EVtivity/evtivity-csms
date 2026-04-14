// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Subscription } from '@evtivity/lib';
import { db } from '@evtivity/database';
import { getPubSub } from './pubsub.js';

const RESPONSE_TIMEOUT_MS = 35_000;
const RESULTS_CHANNEL = 'ocpp_command_results';

export interface CommandResult {
  commandId: string;
  response?: Record<string, unknown>;
  error?: string;
}

export async function sendOcppCommandAndWait(
  stationOcppId: string,
  action: string,
  payload: Record<string, unknown>,
  version?: string,
): Promise<CommandResult> {
  const commandId = crypto.randomUUID();
  const pubsub = getPubSub();
  let subscription: Subscription | null = null;

  try {
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (subscription != null) {
          void subscription.unsubscribe().catch(() => {});
          subscription = null;
        }
        resolve({ commandId, error: 'No response within 35s' });
      }, RESPONSE_TIMEOUT_MS);

      void pubsub
        .subscribe(RESULTS_CHANNEL, (raw: string) => {
          let parsed: CommandResult;
          try {
            parsed = JSON.parse(raw) as CommandResult;
          } catch {
            return;
          }
          if (parsed.commandId !== commandId) return;

          clearTimeout(timeout);
          if (subscription != null) {
            void subscription.unsubscribe().catch(() => {});
            subscription = null;
          }
          resolve(parsed);
        })
        .then(async (sub) => {
          subscription = sub;

          const notification = JSON.stringify({
            commandId,
            stationId: stationOcppId,
            action,
            payload,
            ...(version != null ? { version } : {}),
          });
          await pubsub.publish('ocpp_commands', notification);
        })
        .catch((err: unknown) => {
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    return result;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- subscription is set asynchronously in .then()
    if (subscription != null) {
      void (subscription as Subscription).unsubscribe().catch(() => {});
    }
    return { commandId, error: 'Internal error sending command' };
  }
}

const STATUS_CHECK_TIMEOUT_MS = 10_000;
const STATUS_POLL_INTERVAL_MS = 500;

export async function triggerAndWaitForStatus(
  stationOcppId: string,
  evseId: number,
  connectorId: number,
  stationDbId: string,
  version?: string,
): Promise<{ status: string | null; error?: string }> {
  // Read current status + updated_at before triggering
  const before = await db.execute<{ status: string; updated_at: string }>(
    sql`SELECT c.status, c.updated_at
        FROM connectors c
        JOIN evses e ON c.evse_id = e.id
        WHERE e.station_id = ${stationDbId} AND e.evse_id = ${evseId} AND c.connector_id = ${connectorId}`,
  );
  const beforeRow = before[0];
  if (beforeRow == null) {
    return { status: null, error: 'Connector not found' };
  }
  const beforeUpdatedAt = new Date(beforeRow.updated_at).getTime();

  // Send TriggerMessage to station
  const triggerPayload =
    version === 'ocpp1.6'
      ? { requestedMessage: 'StatusNotification', connectorId }
      : { requestedMessage: 'StatusNotification', evse: { id: evseId, connectorId } };

  const cmdResult = await sendOcppCommandAndWait(
    stationOcppId,
    'TriggerMessage',
    triggerPayload,
    version,
  );

  if (cmdResult.error != null) {
    return { status: null, error: 'Station did not respond to status check' };
  }

  const response = cmdResult.response as { status?: string } | undefined;
  if (response?.status !== 'Accepted' && response?.status !== 'NotImplemented') {
    return { status: null, error: 'Station rejected status check' };
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
  return { status: null, error: 'Status check timed out. Replug the connector and try again.' };
}
