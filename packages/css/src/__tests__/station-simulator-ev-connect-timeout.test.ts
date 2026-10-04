// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';

// OCPP 2.1 EVConnectionTimeOut of an authorization without a cable. The
// simulator starts a transaction only with the cable connected (PowerPathClosed),
// so the timeout ends the authorization and reports no transaction (C01.FR.26).

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

interface Internals {
  handleCsmsCommand(
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  seedDefaultConfigVariables(): void;
}

function makeSimulator(): {
  sim: StationSimulator;
  start: () => Promise<Record<string, unknown>>;
  txSpy: ReturnType<typeof vi.spyOn>;
  statusSpy: ReturnType<typeof vi.spyOn>;
} {
  const sim = new StationSimulator(
    makeConfig({
      configOverrides: {
        'TxCtrlr.EVConnectionTimeOut': '2',
        'AuthCtrlr.AuthorizeRemoteStart': 'false',
      },
    }),
    noopSql(),
  );
  Object.defineProperty(sim.client, 'sendCall', { value: vi.fn(async () => ({})), writable: true });
  Object.defineProperty(sim.client, 'isConnected', { get: () => true });
  const internals = sim as unknown as Internals;
  internals.seedDefaultConfigVariables();
  const txSpy = vi.spyOn(sim, 'sendTransactionEvent').mockResolvedValue({});
  const statusSpy = vi.spyOn(sim, 'sendStatusNotification').mockResolvedValue(undefined);
  const start = (): Promise<Record<string, unknown>> =>
    internals.handleCsmsCommand.call(internals, 'm1', 'RequestStartTransaction', {
      evseId: 1,
      remoteStartId: 7,
      idToken: { idToken: 'DRIVER-1', type: 'Central' },
    });
  return { sim, start, txSpy, statusSpy };
}

describe('EVConnectionTimeOut before the cable (OCPP 2.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the authorization without inventing a transaction', async () => {
    const { start, txSpy, statusSpy } = makeSimulator();

    expect(await start()).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(txSpy).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(1, 1, 'Available');
  });

  it('accepts a new remote start once the authorization ended (TC_F_04_CS step 3)', async () => {
    const { start } = makeSimulator();

    await start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await start()).toEqual({ status: 'Accepted' });
  });

  it('starts the transaction when the cable is plugged in before the timeout', async () => {
    const { sim, start, txSpy } = makeSimulator();

    await start();
    await sim.plugIn(1);
    await vi.advanceTimersByTimeAsync(2_000);

    const events = (txSpy.mock.calls as unknown[][]).map((c) => [
      c[1],
      (c[2] as { triggerReason?: string }).triggerReason,
    ]);
    expect(events[0]).toEqual(['Started', 'RemoteStart']);
    expect(events.some((e) => e[1] === 'EVConnectTimeout')).toBe(false);
  });
});
