// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { createLogger } from '@evtivity/lib';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import type { OcpiVersion, OcpiCommandResult } from '../../types/ocpi.js';

const logger = createLogger('ocpi-emsp-commands');

// In-memory store for pending outbound commands awaiting async results
const MAX_PENDING_COMMANDS = 10_000;
const pendingCommands = new Map<
  string,
  {
    resolve: (result: OcpiCommandResult) => void;
    timer: ReturnType<typeof setTimeout>;
    partnerId: string;
  }
>();

export function registerPendingCommand(
  commandId: string,
  timeoutMs: number,
  partnerId: string,
): Promise<OcpiCommandResult> {
  if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
    logger.warn(
      { size: pendingCommands.size },
      'Pending commands limit reached, rejecting new command',
    );
    return Promise.resolve({ result: 'REJECTED' });
  }

  return new Promise<OcpiCommandResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      resolve({ result: 'TIMEOUT' });
    }, timeoutMs);

    pendingCommands.set(commandId, { resolve, timer, partnerId });
  });
}

function registerEmspCommandRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/emsp/commands`;

  // POST /ocpi/{version}/emsp/commands/:command/callback
  // CPO partner sends async CommandResult to us
  app.post(
    `${prefix}/:command/callback`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const body = request.body as OcpiCommandResult | null;
      if (body == null || typeof body.result !== 'string') {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid CommandResult'));
        return;
      }

      // Check X-Correlation-ID to match with pending command
      const correlationId = request.headers['x-correlation-id'] as string | undefined;

      logger.info(
        { partnerId: partner.partnerId, result: body.result, correlationId },
        'Received command result from CPO',
      );

      if (correlationId != null) {
        const pending = pendingCommands.get(correlationId);
        if (pending != null) {
          if (pending.partnerId !== partner.partnerId) {
            logger.warn(
              { correlationId, expected: pending.partnerId, actual: partner.partnerId },
              'Command callback partner mismatch',
            );
          } else {
            clearTimeout(pending.timer);
            pendingCommands.delete(correlationId);
            pending.resolve(body);
          }
        }
      }

      return ocpiSuccess(null);
    },
  );
}

export function emspCommandRoutes(app: FastifyInstance): void {
  registerEmspCommandRoutes(app, '2.2.1');
  registerEmspCommandRoutes(app, '2.3.0');
}
