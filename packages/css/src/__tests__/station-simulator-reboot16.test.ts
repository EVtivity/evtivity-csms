// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator } from '../station-simulator.js';
import { config as cssConfig } from '../lib/config.js';
import { makeConfig } from './sim-test-helpers.js';

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

interface Internals {
  simulateReset: (type: string) => Promise<void>;
  rebootConnections: () => Array<{ serverUrl: string; securityProfile: number }> | null;
  pendingSecurityProfile16: number | null;
  seedDefaultConfigVariables: () => void;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OCPP 1.6 reset reboots the connection', () => {
  it('reconnects through OcppClient.reconnectNow and boots on the new connection', async () => {
    vi.useFakeTimers();
    const sim = new StationSimulator(makeConfig({ ocppProtocol: 'ocpp1.6' }), noopSql());
    const sendCall = vi.fn(async () => ({}));
    const reconnectNow = vi.fn();
    Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
    Object.defineProperty(sim.client, 'reconnectNow', { value: reconnectNow, writable: true });

    const done = (sim as unknown as Internals).simulateReset('Immediate');
    await vi.advanceTimersByTimeAsync(600);
    await done;

    expect(reconnectNow).toHaveBeenCalledTimes(1);
    expect((sim as unknown as { rebootOnReconnect: boolean }).rebootOnReconnect).toBe(true);
    expect(sendCall).not.toHaveBeenCalledWith('BootNotification', expect.anything());
  });

  it('keeps the current TLS URL for an upgrade from profile 2, and switches to TLS from 1', () => {
    const tls = new StationSimulator(
      makeConfig({ ocppProtocol: 'ocpp1.6', securityProfile: 2, targetUrl: 'wss://cs.test/ocpp' }),
      noopSql(),
    ) as unknown as Internals;
    tls.pendingSecurityProfile16 = 3;
    expect(tls.rebootConnections()?.[0]).toMatchObject({
      serverUrl: 'wss://cs.test/ocpp',
      securityProfile: 3,
    });

    const plain = new StationSimulator(
      makeConfig({ ocppProtocol: 'ocpp1.6', securityProfile: 1, targetUrl: 'ws://cs.test/ocpp' }),
      noopSql(),
    ) as unknown as Internals;
    plain.pendingSecurityProfile16 = 2;
    expect(plain.rebootConnections()?.[0]).toMatchObject({
      serverUrl: cssConfig.OCPP_TLS_SERVER_URL,
      securityProfile: 2,
    });
  });
});
