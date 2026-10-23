// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from 'fastify';
import { isAllowedSimulatorTarget } from '@evtivity/lib';
import { config } from './config.js';

/**
 * The OCPP server URLs a simulator may connect to: the plain and TLS endpoints
 * the simulator pairing uses (`css-pairing.ts`), and the TLS address stations
 * get when moved to TLS (`OCPP_STATION_TLS_URL`).
 */
export function simulatorServerUrls(): string[] {
  return [config.OCPP_SERVER_URL, config.OCPP_TLS_SERVER_URL, config.OCPP_STATION_TLS_URL ?? ''];
}

/**
 * Answers 400 VALIDATION_ERROR and returns true when a simulator target URL is
 * not on the OCPP server's origin: the simulator would send the station password or certificate to that host.
 */
export async function refuseSimulatorTarget(
  reply: FastifyReply,
  targetUrl: string | undefined,
): Promise<boolean> {
  if (targetUrl === undefined || isAllowedSimulatorTarget(targetUrl, simulatorServerUrls())) {
    return false;
  }
  await reply.status(400).send({
    error: 'The simulator target must be a ws or wss URL of the OCPP server',
    code: 'VALIDATION_ERROR',
    details: { targetUrl: 'not the OCPP server' },
  });
  return true;
}
