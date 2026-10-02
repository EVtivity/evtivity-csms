// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

describe('StationSimulator NotifyReport', () => {
  it('reports EVSE rated power as variableCharacteristics maxLimit in W', async () => {
    const sim = new StationSimulator(makeConfig(), noopSql());
    const sendCall = vi.fn(async (_action: string, _payload: unknown) => ({}));
    Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
    const configVariables = (
      sim as unknown as { configVariables: Map<string, { value: string; readonly: boolean }> }
    ).configVariables;
    configVariables.set('EVSE[1].Power', { value: '22000', readonly: true });
    configVariables.set('OCPPCommCtrlr.HeartbeatInterval', { value: '300', readonly: false });

    await sim.sendNotifyReport(1);

    const call = sendCall.mock.calls.find((c) => c[0] === 'NotifyReport');
    const reportData =
      (call?.[1] as { reportData: Array<Record<string, unknown>> } | undefined)?.reportData ?? [];
    const power = reportData.find(
      (r) =>
        (r['component'] as { name: string }).name === 'EVSE' &&
        (r['variable'] as { name: string }).name === 'Power',
    );
    expect(power?.['variableCharacteristics']).toMatchObject({
      unit: 'W',
      dataType: 'decimal',
      maxLimit: 22000,
    });
    const heartbeat = reportData.find(
      (r) => (r['variable'] as { name: string }).name === 'HeartbeatInterval',
    );
    expect(heartbeat?.['variableCharacteristics']).toEqual({
      dataType: 'string',
      supportsMonitoring: false,
    });
  });
});
