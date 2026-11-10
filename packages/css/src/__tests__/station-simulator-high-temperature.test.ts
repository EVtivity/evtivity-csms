// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The High Temperature fault and the simulated security events: 1.6 carries
// HighTemperature as the StatusNotification errorCode; 2.0.1 and 2.1 report
// Faulted and a NotifyEvent of the EVSE TemperatureSensor Temperature, cleared
// with the fault. SecurityEventNotification goes out as the station's message
// on every version.

import { describe, it, expect, vi, type Mock } from 'vitest';
import type postgres from 'postgres';
import {
  SIMULATED_HIGH_TEMPERATURE_C,
  SIMULATED_NORMAL_TEMPERATURE_C,
  StationSimulator,
  type StationConfig,
} from '../station-simulator.js';
import type { OcppProtocol } from '@evtivity/lib/ocpp-version';

function noopSql(): postgres.Sql {
  return ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
}

type SendCall = Mock<(action: string, payload?: Record<string, unknown>) => Promise<unknown>>;

function makeSimulator(ocppProtocol: OcppProtocol): {
  sim: StationSimulator;
  sendCall: SendCall;
} {
  const config: StationConfig = {
    id: 'css_temp',
    stationId: 'TEMP-001',
    ocppProtocol,
    securityProfile: 0,
    targetUrl: 'ws://localhost:7103',
    vendorName: 'TestVendor',
    model: 'TestModel',
    serialNumber: 'SN-1',
    firmwareVersion: '1.0',
    evses: [
      {
        evseId: 1,
        connectorId: 1,
        connectorType: 'ac_type2',
        maxPowerW: 22000,
        phases: 3,
        voltage: 230,
      },
    ],
  };
  const sim = new StationSimulator(config, noopSql());
  const sendCall: SendCall = vi.fn(() => Promise.resolve({ status: 'Accepted' }));
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  (sim as unknown as { evseConnectorStatus: Map<number, string> }).evseConnectorStatus.set(
    1,
    'Available',
  );
  return { sim, sendCall };
}

function callsOf(sendCall: SendCall, action: string): Record<string, unknown>[] {
  return sendCall.mock.calls
    .filter((c) => c[0] === action)
    .map((c) => c[1] as Record<string, unknown>);
}

function temperatureEvents(sendCall: SendCall): Record<string, unknown>[] {
  return callsOf(sendCall, 'NotifyEvent')
    .flatMap((p) => p['eventData'] as Record<string, unknown>[])
    .filter((e) => (e['component'] as { name: string }).name === 'TemperatureSensor');
}

describe('High Temperature fault', () => {
  it('reports HighTemperature as the 1.6 StatusNotification errorCode, with no NotifyEvent', async () => {
    const { sim, sendCall } = makeSimulator('ocpp1.6');
    await sim.injectFault(1, 'HighTemperature');
    const status = callsOf(sendCall, 'StatusNotification').at(-1);
    expect(status).toMatchObject({ status: 'Faulted', errorCode: 'HighTemperature' });
    expect(callsOf(sendCall, 'NotifyEvent')).toEqual([]);
  });

  it.each(['ocpp2.1', 'ocpp2.0.1'] as const)(
    'reports %s Faulted and the EVSE temperature, cleared with the fault',
    async (protocol) => {
      const { sim, sendCall } = makeSimulator(protocol);
      await sim.injectFault(1, 'HighTemperature');
      const faulted = callsOf(sendCall, 'StatusNotification').at(-1);
      expect(faulted).toMatchObject({ connectorStatus: 'Faulted', evseId: 1 });
      const [high] = temperatureEvents(sendCall);
      expect(high).toMatchObject({
        trigger: 'Alerting',
        actualValue: SIMULATED_HIGH_TEMPERATURE_C,
        techCode: 'HighTemperature',
        component: { name: 'TemperatureSensor', evse: { id: 1 } },
        variable: { name: 'Temperature' },
        eventNotificationType: 'HardWiredNotification',
      });
      expect(high).not.toHaveProperty('cleared');

      await sim.clearFault(1);
      const events = temperatureEvents(sendCall);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        actualValue: SIMULATED_NORMAL_TEMPERATURE_C,
        cleared: true,
      });

      // A second clear of a cleared fault sends nothing more.
      await sim.clearFault(1);
      expect(temperatureEvents(sendCall)).toHaveLength(2);
    },
  );

  it('sends no temperature event for another fault', async () => {
    const { sim, sendCall } = makeSimulator('ocpp2.1');
    await sim.injectFault(1, 'InternalError');
    await sim.clearFault(1);
    expect(temperatureEvents(sendCall)).toEqual([]);
  });

  it('keeps the fault when the temperature NotifyEvent fails', async () => {
    const { sim, sendCall } = makeSimulator('ocpp2.1');
    sendCall.mockImplementation((action: string) =>
      action === 'NotifyEvent' ? Promise.reject(new Error('offline')) : Promise.resolve({}),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sim.injectFault(1, 'HighTemperature')).resolves.toBeUndefined();
    expect(callsOf(sendCall, 'StatusNotification').at(-1)).toMatchObject({
      connectorStatus: 'Faulted',
    });
    warn.mockRestore();
  });
});

describe('simulated security events', () => {
  it.each(['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const)(
    'sends a %s SecurityEventNotification with the type, the time and the tech info',
    async (protocol) => {
      const { sim, sendCall } = makeSimulator(protocol);
      await sim.sendSecurityEventNotification('TiltDetected', undefined, 'tilt 35 degrees');
      const [payload] = callsOf(sendCall, 'SecurityEventNotification');
      expect(payload).toMatchObject({ type: 'TiltDetected', techInfo: 'tilt 35 degrees' });
      expect(Number.isNaN(Date.parse(String(payload?.['timestamp'])))).toBe(false);
    },
  );
});
