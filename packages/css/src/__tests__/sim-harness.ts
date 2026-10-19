// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi, type Mock } from 'vitest';
import type postgres from 'postgres';
import type { OcppProtocol } from '@evtivity/lib/ocpp-version';
import { StationSimulator, type StationConfig } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';
import { assertOcpp201 } from './ocpp201-schema.js';

export type Protocol = OcppProtocol;

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
  /** OCPP 2.0.1 schema failures of every message sent or received (the simulator may swallow the throw). */
  violations: string[];
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

// Default CSMS answers in their 2.0.1 form (no 1.6 idTagInfo next to idTokenInfo).
export function defaultResponse201(action: string): unknown {
  switch (action) {
    case 'Authorize':
      return { idTokenInfo: { status: 'Accepted' } };
    case 'TransactionEvent':
      return {};
    case 'BootNotification':
      return { status: 'Accepted', interval: 300, currentTime: new Date().toISOString() };
    case 'Heartbeat':
      return { currentTime: new Date().toISOString() };
    case 'DataTransfer':
    case 'SignCertificate':
    case 'NotifyEVChargingNeeds':
    case 'NotifyEVChargingSchedule':
    case 'GetCertificateStatus':
      return { status: 'Accepted' };
    case 'Get15118EVCertificate':
      return { status: 'Accepted', exiResponse: 'AA==' };
    case 'GetTransactionStatus':
      return { messagesInQueue: false };
    default:
      // StatusNotification, MeterValues, the Notify* reports and status notifications.
      return {};
  }
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const protocol = opts.protocol ?? 'ocpp2.1';
  const sim = new StationSimulator(
    makeConfig({ ocppProtocol: protocol, ...opts.config }),
    opts.sql ?? stubSql(),
  );
  const is201 = protocol === 'ocpp2.0.1';
  const respond = opts.respond ?? (is201 ? defaultResponse201 : defaultResponse);
  // OCPP 2.0.1: every CALL goes through the client's own 2.0.1 edge and must pass the
  // strict 2.0.1 schema, as a 2.0.1 CSMS would check it; the recorded payload is the wire one.
  const toWire = sim.client.callPayload.bind(sim.client);
  const toWireResult = sim.client.callResultPayload.bind(sim.client);
  const violations: string[] = [];
  const check = (action: string, kind: 'request' | 'response', pl: Record<string, unknown>) => {
    try {
      assertOcpp201(action, kind, pl);
    } catch (err) {
      violations.push(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
  const sendCall = vi.fn(async (action: string, payload: Record<string, unknown>) => {
    if (is201) {
      let wire: Record<string, unknown> | null;
      try {
        wire = toWire(action, payload);
      } catch (err) {
        violations.push(err instanceof Error ? err.message : String(err));
        throw err;
      }
      if (wire == null) return {};
      check(action, 'request', wire);
      const r = (respond(action, wire) ?? defaultResponse201(action)) as Record<string, unknown>;
      check(action, 'response', r);
      return r;
    }
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
  const calls = (): Array<[string, Record<string, unknown>]> =>
    is201
      ? sendCall.mock.calls.flatMap(([a, pl]: [string, Record<string, unknown>]) => {
          let wire: Record<string, unknown> | null;
          try {
            wire = toWire(a, pl);
          } catch {
            // fail-open: a message the 2.0.1 edge refused never left the station, see violations
            return [];
          }
          return wire == null ? [] : [[a, wire] as [string, Record<string, unknown>]];
        })
      : sendCall.mock.calls;
  const handle = p['handleCsmsCommand'] as (
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  return {
    sim,
    sendCall,
    p,
    invoke: async (action, payload) => {
      if (!is201) return handle.call(sim, 'm1', action, payload);
      // A 2.0.1 station validates the CSMS call (a 2.1-only field fails here) and answers in 2.0.1.
      check(action, 'request', payload);
      const reply = await handle.call(sim, 'm1', action, payload);
      const wire = toWireResult(action, reply);
      check(action, 'response', wire);
      return wire;
    },
    sent: (action) =>
      calls()
        .filter((c) => c[0] === action)
        .map((c) => c[1]),
    actions: () => calls().map((c) => c[0]),
    violations,
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
