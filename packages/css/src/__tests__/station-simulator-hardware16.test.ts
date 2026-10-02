// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator, type StationConfig } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

interface Internals {
  handleCsmsCommand: (
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  seedDefaultConfigVariables: () => void;
}

function makeSimulator(overrides: Partial<StationConfig> = {}): {
  sim: StationSimulator;
  sendCall: ReturnType<typeof vi.fn>;
} {
  const sim = new StationSimulator(
    makeConfig({ ocppProtocol: 'ocpp1.6', ...overrides }),
    noopSql(),
  );
  (sim as unknown as Internals).seedDefaultConfigVariables();
  const sendCall = vi.fn(async () => ({}));
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  return { sim, sendCall };
}

function command(
  sim: StationSimulator,
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (sim as unknown as Internals).handleCsmsCommand('msg-1', action, payload);
}

const entry = (idTag: string) => ({ idTag, idTagInfo: { status: 'Accepted' } });

describe('StationSimulator OCPP 1.6 connector hardware', () => {
  it('answers NotSupported to UnlockConnector for a fixed cable', async () => {
    const base = makeConfig();
    const { sim } = makeSimulator({
      evses: base.evses.map((e) => ({ ...e, fixedCable: true })),
    });
    expect(await command(sim, 'UnlockConnector', { connectorId: 1 })).toEqual({
      status: 'NotSupported',
    });
  });

  it('answers UnlockFailed and reports ConnectorLockFailure when the lock is jammed', async () => {
    vi.useFakeTimers();
    try {
      const { sim, sendCall } = makeSimulator();
      sim.jamConnectorLock(1);
      expect(await command(sim, 'UnlockConnector', { connectorId: 1 })).toEqual({
        status: 'UnlockFailed',
      });
      expect(sendCall).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(sendCall).toHaveBeenCalledWith('StatusNotification', {
        connectorId: 1,
        errorCode: 'ConnectorLockFailure',
        status: 'Faulted',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports ConnectorLockFailure and drops the pending start when the plug is half in', async () => {
    const { sim, sendCall } = makeSimulator();
    expect(
      await command(sim, 'RemoteStartTransaction', { connectorId: 1, idTag: 'TAG-1' }),
    ).toEqual({ status: 'Accepted' });
    await sim.plugInHalfway(1);
    expect(sendCall).toHaveBeenCalledWith('StatusNotification', {
      connectorId: 1,
      errorCode: 'ConnectorLockFailure',
      status: 'Faulted',
    });
    expect(sendCall).not.toHaveBeenCalledWith('StartTransaction', expect.anything());
  });
});

describe('StationSimulator OCPP 1.6 Local Authorization List limits', () => {
  it('reports listVersion -1 while LocalAuthListEnabled is false', async () => {
    const { sim } = makeSimulator();
    expect(await command(sim, 'GetLocalListVersion', {})).toEqual({ listVersion: 0 });
    await command(sim, 'ChangeConfiguration', { key: 'LocalAuthListEnabled', value: 'false' });
    expect(await command(sim, 'GetLocalListVersion', {})).toEqual({ listVersion: -1 });
  });

  it('refuses SendLocalList without the LocalAuthListManagement feature profile', async () => {
    const { sim } = makeSimulator({
      configOverrides: { SupportedFeatureProfiles: 'Core,RemoteTrigger' },
    });
    expect(
      await command(sim, 'SendLocalList', {
        listVersion: 1,
        updateType: 'Full',
        localAuthorizationList: [entry('TAG-1')],
      }),
    ).toEqual({ status: 'NotSupported' });
    expect(await command(sim, 'GetLocalListVersion', {})).toEqual({ listVersion: -1 });
  });

  it('fails a list larger than LocalAuthListMaxLength', async () => {
    const { sim } = makeSimulator({ configOverrides: { LocalAuthListMaxLength: '1' } });
    expect(
      await command(sim, 'SendLocalList', {
        listVersion: 2,
        updateType: 'Full',
        localAuthorizationList: [entry('TAG-1'), entry('TAG-2')],
      }),
    ).toEqual({ status: 'Failed' });
    expect(
      await command(sim, 'SendLocalList', {
        listVersion: 2,
        updateType: 'Full',
        localAuthorizationList: [entry('TAG-1')],
      }),
    ).toEqual({ status: 'Accepted' });
  });
});
