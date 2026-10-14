// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ServiceLogger } from '@evtivity/lib';
import { sendOcppCommandAndWait } from './ocpp-command.js';

function classifyCommandResult(result: { response?: Record<string, unknown>; error?: string }): {
  commandStatus: string;
  error: string | null;
} {
  if (result.error != null) {
    const offline = result.error.includes('is not connected');
    return { commandStatus: offline ? 'offline' : 'failed', error: result.error };
  }
  const status = (result.response as { status?: string } | undefined)?.status;
  return { commandStatus: (status ?? 'accepted').toLowerCase(), error: null };
}

// Canonical 2.1 payload with no version arg: the OCPP dispatcher translates
// per the station's live protocol (1.6 gets { connectorId: 0, type }).
// Passing a version would skip translation and send this payload raw to 1.6
// stations, which silently ignore it.
// With a target, only that EVSE (or connector) changes: 2.1 `evse { id,
// connectorId }`; a 1.6 station gets the EVSE number as its connectorId.
export async function sendAvailabilityCommand(
  stationOcppId: string,
  operationalStatus: 'Inoperative' | 'Operative',
  logger?: ServiceLogger,
  target?: { evseId: number; connectorId?: number },
): Promise<{ command: string; commandStatus: string; error: string | null }> {
  const command = `ChangeAvailability(${operationalStatus})`;
  try {
    const result = await sendOcppCommandAndWait(stationOcppId, 'ChangeAvailability', {
      operationalStatus,
      ...(target != null
        ? {
            evse: {
              id: target.evseId,
              ...(target.connectorId != null ? { connectorId: target.connectorId } : {}),
            },
          }
        : {}),
    });
    const classified = classifyCommandResult(result);
    if (classified.error != null) {
      logger?.warn({ stationId: stationOcppId, error: classified.error }, `${command} failed`);
    }
    return { command, ...classified };
  } catch (err) {
    logger?.warn({ err, stationId: stationOcppId }, `${command} failed`);
    return {
      command,
      commandStatus: 'failed',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
