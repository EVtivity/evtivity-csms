// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
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

/**
 * Wait for the first message of an action that matches a predicate, skipping
 * (and consuming) the ones that do not. Returns null on timeout.
 */
export async function waitForMatchingMessage(
  server: OcppTestServer,
  action: string,
  matches: (payload: Record<string, unknown>) => boolean,
  timeoutMs: number = 10_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const msg = await server.waitForMessage(action, Math.max(1, deadline - Date.now()));
      if (matches(msg)) return msg;
    } catch {
      break;
    }
  }
  return null;
}

/** An HTTP server for one file, such as a firmware image a test serves to the station. */
export interface FileServer {
  url: string;
  /** Number of completed GET requests for the file. */
  downloads: () => number;
  close: () => Promise<void>;
}

export async function startFileServer(path: string, content: Buffer): Promise<FileServer> {
  let downloads = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === path) {
      downloads++;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': content.length,
      });
      res.end(content);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const addr = server.address();
  if (addr == null || typeof addr === 'string') throw new Error('File server has no address');
  return {
    url: `http://127.0.0.1:${String(addr.port)}${path}`,
    downloads: () => downloads,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

/** One device model write: component name (with optional EVSE), variable name, value. */
export interface VariableSetting {
  component: string;
  variable: string;
  value: string;
  evseId?: number | undefined;
  instance?: string | undefined;
}

/**
 * Configuration State: the Test System sets device model variables with a
 * SetVariablesRequest. Returns `component.variable=status` for every result
 * that was not Accepted (empty when all were accepted).
 */
export async function setVariables(
  server: OcppTestServer,
  settings: VariableSetting[],
): Promise<string[]> {
  const resp = await server.sendCommand('SetVariables', {
    setVariableData: settings.map((s) => {
      const component: Record<string, unknown> = { name: s.component };
      if (s.evseId != null) component['evse'] = { id: s.evseId };
      const variable: Record<string, unknown> = { name: s.variable };
      if (s.instance != null) variable['instance'] = s.instance;
      return { component, variable, attributeValue: s.value };
    }),
  });
  const results = (resp['setVariableResult'] ?? []) as Array<Record<string, unknown>>;
  return results
    .filter((r) => r['attributeStatus'] !== 'Accepted')
    .map((r) => {
      const c = r['component'] as Record<string, unknown> | undefined;
      const v = r['variable'] as Record<string, unknown> | undefined;
      return `${String(c?.['name'])}.${String(v?.['name'])}=${String(r['attributeStatus'])}`;
    });
}

/**
 * Collect every message of `action` the station sends until `quietMs` passes
 * without one, or `maxMs` in total.
 */
export async function collectMessages(
  server: OcppTestServer,
  action: string,
  quietMs: number,
  maxMs: number,
): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const wait = Math.min(quietMs, deadline - Date.now());
    if (wait <= 0) break;
    try {
      messages.push(await server.waitForMessage(action, wait));
    } catch {
      break;
    }
  }
  return messages;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the first TransactionEvent the station generates after it emptied
 * its offline queue: queued messages (offline true) are delivered first, so
 * they are skipped.
 */
export async function waitForTransactionEventAfterQueue(
  server: OcppTestServer,
  timeoutMs: number = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const msg = await server.waitForMessage('TransactionEvent', Math.max(1, deadline - Date.now()));
    if (msg['offline'] !== true) return msg;
  }
}
