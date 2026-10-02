// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';

const KEY = 'SimulatorCtrlr.StatusReporting';

// SQL stub that returns `configRows` for the css_config_variables load and an
// empty result for everything else.
function sqlWithConfig(configRows: Array<Record<string, unknown>>): postgres.Sql {
  const fn = ((strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join('').includes('FROM css_config_variables') ? configRows : [],
    )) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

function configVariables(sim: StationSimulator): Map<string, { value: string; readonly: boolean }> {
  return (sim as unknown as { configVariables: Map<string, { value: string; readonly: boolean }> })
    .configVariables;
}

function loadConfigVariables(sim: StationSimulator): Promise<void> {
  return (sim as unknown as { loadConfigVariables(): Promise<void> }).loadConfigVariables();
}

function makeSimulator(reporting?: string): {
  sim: StationSimulator;
  sendCall: ReturnType<typeof vi.fn>;
} {
  const sim = new StationSimulator(makeConfig(), sqlWithConfig([]));
  const sendCall = vi.fn(async () => ({}));
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  if (reporting != null) configVariables(sim).set(KEY, { value: reporting, readonly: false });
  return { sim, sendCall };
}

function sentActions(sendCall: ReturnType<typeof vi.fn>): string[] {
  return sendCall.mock.calls.map((call) => String(call[0]));
}

describe('StationSimulator status reporting', () => {
  it('sends StatusNotification and NotifyEvent by default', async () => {
    const { sim, sendCall } = makeSimulator();
    await sim.sendStatusNotification(1, 1, 'Available');
    expect(sentActions(sendCall)).toEqual(['StatusNotification', 'NotifyEvent']);
  });

  it('sends only NotifyEvent AvailabilityState in NotifyEvent mode', async () => {
    const { sim, sendCall } = makeSimulator('NotifyEvent');
    await sim.sendStatusNotification(1, 1, 'Occupied');
    expect(sentActions(sendCall)).toEqual(['NotifyEvent']);
    const payload = sendCall.mock.calls[0]?.[1] as {
      eventData: Array<Record<string, unknown>>;
    };
    expect(payload.eventData[0]).toMatchObject({
      actualValue: 'Occupied',
      component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
      variable: { name: 'AvailabilityState' },
    });
  });

  it('sends only StatusNotification in StatusNotification mode', async () => {
    const { sim, sendCall } = makeSimulator('StatusNotification');
    await sim.sendStatusNotification(1, 1, 'Available');
    expect(sentActions(sendCall)).toEqual(['StatusNotification']);
  });

  it('propagates a failed NotifyEvent when it is the only status report', async () => {
    const { sim, sendCall } = makeSimulator('NotifyEvent');
    sendCall.mockRejectedValueOnce(new Error('closed'));
    await expect(sim.sendStatusNotification(1, 1, 'Available')).rejects.toThrow('closed');
  });

  it('adds the variable on boot for a station provisioned without it', async () => {
    const sim = new StationSimulator(
      makeConfig(),
      sqlWithConfig([{ key: 'OCPPCommCtrlr.HeartbeatInterval', value: '300', readonly: false }]),
    );
    await loadConfigVariables(sim);
    expect(configVariables(sim).get(KEY)).toEqual({ value: 'Both', readonly: false });
  });

  it('keeps a stored value on boot', async () => {
    const sim = new StationSimulator(
      makeConfig(),
      sqlWithConfig([{ key: KEY, value: 'NotifyEvent', readonly: false }]),
    );
    await loadConfigVariables(sim);
    expect(configVariables(sim).get(KEY)?.value).toBe('NotifyEvent');
  });

  it('rejects an unknown value in SetVariables', async () => {
    const { sim } = makeSimulator('Both');
    const handler = (
      sim as unknown as {
        handleCsmsCommand: (
          id: string,
          action: string,
          payload: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).handleCsmsCommand;
    const set = (value: string) =>
      handler.call(sim, 'm1', 'SetVariables', {
        setVariableData: [
          {
            component: { name: 'SimulatorCtrlr' },
            variable: { name: 'StatusReporting' },
            attributeValue: value,
          },
        ],
      });

    const rejected = (await set('Sometimes'))['setVariableResult'] as Array<{
      attributeStatus: string;
    }>;
    expect(rejected[0]?.attributeStatus).toBe('Rejected');
    expect(configVariables(sim).get(KEY)?.value).toBe('Both');

    const accepted = (await set('NotifyEvent'))['setVariableResult'] as Array<{
      attributeStatus: string;
    }>;
    expect(accepted[0]?.attributeStatus).toBe('Accepted');
    expect(configVariables(sim).get(KEY)?.value).toBe('NotifyEvent');
  });
});
