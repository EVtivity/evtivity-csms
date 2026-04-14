// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppTestServer } from './cs-server.js';

/**
 * Wait for a TransactionEvent with the specified chargingState.
 * Skips TransactionEvents that don't match (e.g., EVConnected before Charging).
 */
export async function waitForChargingState(
  server: OcppTestServer,
  targetState: string,
  timeoutMs: number = 10_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const msg = await server.waitForMessage('TransactionEvent', remaining);
      const txInfo = msg['transactionInfo'] as Record<string, unknown> | undefined;
      const chState = txInfo?.['chargingState'] as string | undefined;
      if (chState === targetState) return msg;
    } catch {
      break;
    }
  }
  return null;
}

/**
 * Start charging and wait for the Charging TransactionEvent (OCPP 2.1).
 * Calls plugIn + startCharging, then finds the TransactionEvent(Charging).
 * Returns the TransactionEvent payload or null if not found.
 */
export async function startAndWaitForCharging(
  ctx: {
    station: {
      plugIn(evseId: number): Promise<void>;
      startCharging(evseId: number, token: string, ...args: unknown[]): Promise<unknown>;
    };
    server: OcppTestServer;
  },
  evseId: number,
  token: string,
): Promise<Record<string, unknown> | null> {
  await ctx.station.plugIn(evseId);
  await ctx.station.startCharging(evseId, token);
  return waitForChargingState(ctx.server, 'Charging', 10_000);
}

/**
 * Wait for a TransactionEvent with the specified eventType (Started/Updated/Ended).
 * Skips TransactionEvents that don't match (e.g., MeterValuePeriodic Updated events).
 */
export async function waitForTransactionEventType(
  server: OcppTestServer,
  targetEventType: string,
  timeoutMs: number = 10_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const msg = await server.waitForMessage('TransactionEvent', remaining);
      const evtType = msg['eventType'] as string | undefined;
      if (evtType === targetEventType) return msg;
    } catch {
      break;
    }
  }
  return null;
}

/**
 * Wait for a TransactionEvent with the specified triggerReason.
 * Skips TransactionEvents that don't match.
 */
export async function waitForTriggerReason(
  server: OcppTestServer,
  targetTrigger: string,
  timeoutMs: number = 30_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const msg = await server.waitForMessage('TransactionEvent', remaining);
      const trigger = msg['triggerReason'] as string | undefined;
      if (trigger === targetTrigger) return msg;
    } catch {
      break;
    }
  }
  return null;
}

/**
 * Drain all pending messages of a given action type from the buffer.
 */
export async function drainMessages(
  server: OcppTestServer,
  action: string,
  timeoutMs: number = 500,
): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    try {
      const msg = await server.waitForMessage(action, timeoutMs);
      messages.push(msg);
    } catch {
      break;
    }
  }
  return messages;
}
