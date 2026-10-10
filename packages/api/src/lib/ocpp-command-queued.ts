// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

/**
 * 202 body of a route whose OCPP command the OCPP server held in the offline
 * command queue (the station was not connected). The command is sent when the
 * station reconnects.
 */
export const ocppCommandQueued = z
  .object({
    status: z
      .literal('queued')
      .describe('Indicates the command was queued because the station is offline'),
    code: z.literal('COMMAND_QUEUED').describe('Stable code for offline-queued commands'),
    stationId: z.string().describe('Target station OCPP ID'),
    action: z.string().describe('OCPP action that was dispatched'),
    message: z
      .string()
      .describe('Human-readable note explaining the command will be delivered on reconnect'),
  })
  .passthrough();

export type OcppCommandQueuedBody = z.infer<typeof ocppCommandQueued>;

export function ocppCommandQueuedBody(
  stationId: string,
  action: string,
  message: string | undefined,
): OcppCommandQueuedBody {
  return {
    status: 'queued',
    code: 'COMMAND_QUEUED',
    stationId,
    action,
    message: message ?? 'Station offline, command queued',
  };
}
