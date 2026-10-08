// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi, type Mock } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator, type StationConfig } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';

export type Protocol = 'ocpp1.6' | 'ocpp2.1';

export type SqlResponder = (query: string, values: unknown[]) => unknown[] | undefined;

// Tagged-template SQL stub. Every query resolves to [] unless the responder
// returns rows for it. `json` passes values through so JSONB persistors work.
export function stubSql(responder?: SqlResponder): postgres.Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = Array.isArray(strings) ? strings.join(' ') : '';
    return Promise.resolve(responder?.(query, values) ?? []);
  }) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

export type CallResponder = (action: string, payload: Record<string, unknown>) => unknown;

export interface Harness {
  sim: StationSimulator;
  sendCall: Mock;
  /** Private state access (test-time cast only). */
  p: Record<string, unknown>;
  invoke(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Payloads of every CALL the station sent with this action, in order. */
  sent(action: string): Array<Record<string, unknown>>;
  /** Actions of every CALL the station sent, in order. */
  actions(): string[];
}

export interface HarnessOptions {
  protocol?: Protocol;
  config?: Partial<StationConfig>;
  sql?: postgres.Sql;
  respond?: CallResponder;
  /** Load and seed the default device model (default true). */
  load?: boolean;
  connected?: boolean;
  /** Run the full boot (start(): load, connect, BootNotification, statuses). */
  boot?: boolean;
}

// Default CSMS answers per action, so flows that read the reply proceed.
export function defaultResponse(action: string): unknown {
  switch (action) {
    case 'Authorize':
      return { idTokenInfo: { status: 'Accepted' }, idTagInfo: { status: 'Accepted' } };
    case 'StartTransaction':
      return { transactionId: 4242, idTagInfo: { status: 'Accepted' } };
    case 'StopTransaction':
      return { idTagInfo: { status: 'Accepted' } };
    case 'TransactionEvent':
      return {};
    case 'BootNotification':
      return { status: 'Accepted', interval: 300, currentTime: new Date().toISOString() };
    case 'Heartbeat':
      return { currentTime: new Date().toISOString() };
    default:
      return { status: 'Accepted' };
  }
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const protocol = opts.protocol ?? 'ocpp2.1';
  const sim = new StationSimulator(
    makeConfig({ ocppProtocol: protocol, ...opts.config }),
    opts.sql ?? stubSql(),
  );
  const respond = opts.respond ?? defaultResponse;
  const sendCall = vi.fn(async (action: string, payload: Record<string, unknown>) => {
    const r = respond(action, payload);
    return (r ?? defaultResponse(action)) as Record<string, unknown>;
  });
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  Object.defineProperty(sim.client, 'sendSend', { value: vi.fn(), writable: true });
  Object.defineProperty(sim.client, 'connect', {
    value: vi.fn(async () => {}),
    writable: true,
  });
  Object.defineProperty(sim.client, 'disconnect', { value: vi.fn(), writable: true });
  Object.defineProperty(sim.client, 'reconnectNow', { value: vi.fn(), writable: true });
  Object.defineProperty(sim.client, 'simulateConnectionLoss', { value: vi.fn(), writable: true });
  Object.defineProperty(sim.client, 'isConnected', {
    value: opts.connected ?? true,
    writable: true,
  });
  const p = sim as unknown as Harness['p'];
  if (opts.boot === true) {
    await sim.start();
  } else if (opts.load !== false) {
    await (p['loadConfigVariables'] as () => Promise<void>).call(sim);
  }
  const calls = (): Array<[string, Record<string, unknown>]> => sendCall.mock.calls;
  return {
    sim,
    sendCall,
    p,
    invoke: (action, payload) =>
      (
        p['handleCsmsCommand'] as (
          id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>
      ).call(sim, 'm1', action, payload),
    sent: (action) =>
      calls()
        .filter((c) => c[0] === action)
        .map((c) => c[1]),
    actions: () => calls().map((c) => c[0]),
  };
}

/** Private member access. Callers cast the result to the member's type. */
export function priv(h: Harness, name: string): unknown {
  return h.p[name];
}

/** Call a private method bound to the simulator. */
export function call(h: Harness, name: string, ...args: unknown[]): unknown {
  const fn = h.p[name];
  if (typeof fn !== 'function') throw new Error(`method "${name}" not found on simulator`);
  return fn.apply(h.sim, args);
}

/** Silence the simulator's console output for a test file. */
export function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

// A station whose css_transactions reads follow its in-memory transactions,
// as the real table would after createTransaction / completeTransaction.
export async function liveHarness(protocol: Protocol, respond?: CallResponder): Promise<Harness> {
  let ref: Harness | null = null;
  const sql = stubSql((q, values) => {
    if (ref == null || !q.includes('SELECT transaction_id, meter_start_wh, id_token')) {
      return undefined;
    }
    const evseId = values[1] as number;
    const txId = (priv(ref, 'activeTransactionIds') as Map<number, string>).get(evseId);
    if (txId == null) return [];
    const ctx = (priv(ref, 'evseContexts') as Map<number, { authorizedToken: string | null }>).get(
      evseId,
    );
    return [{ transaction_id: txId, meter_start_wh: 0, id_token: ctx?.authorizedToken ?? '' }];
  });
  const h = await makeHarness({ protocol, sql, boot: true, ...(respond ? { respond } : {}) });
  ref = h;
  h.sendCall.mockClear();
  return h;
}
