// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
  StationSimulator,
  clampStatusForAdminAvailability,
  type StationConfig,
} from '../station-simulator.js';

// Tagged-template no-op SQL stub. Returns an empty array for any query so
// updateEvseStatus / hasAnyActiveTransaction succeed silently. No in-memory
// transaction is set up, so ChangeAvailability applies immediately (Accepted,
// not Scheduled).
function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  return fn;
}

// SQL stub that answers the per-EVSE getActiveTransaction SELECT (which selects
// transaction_id) with a single active-transaction row so stopCharging can run.
// hasAnyActiveTransaction's `SELECT 1 ... LIMIT 1` does not select
// transaction_id, so it falls through to an empty array: after stopCharging
// nulls the in-memory transactionId, hasAnyActiveTransaction reports no active
// transaction and the scheduled availability change applies.
function txAwareSql(): postgres.Sql {
  const fn = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join(' ');
    if (query.includes('transaction_id') && query.includes("status = 'active'")) {
      return Promise.resolve([{ transaction_id: 'tx-1', meter_start_wh: 0, id_token: 'TAG-1' }]);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  return fn;
}

interface TestEvseContext {
  state: string;
  authorizedToken: string | null;
  authorizedTokenType: string | null;
  transactionId: string | null;
  remoteStartId: number | null;
  cablePlugged: boolean;
}

// Seed an in-memory active transaction on an EVSE. The simulator's
// evseContexts map is normally populated by start(); the unit harness does not
// boot, so seed the context directly. hasAnyActiveTransaction consults this map
// before the DB, so a non-null transactionId makes ChangeAvailability return
// Scheduled, and the connector status reflects an in-progress session.
function startInMemoryTransaction(sim: StationSimulator, evseId: number): void {
  const contexts = (sim as unknown as { evseContexts: Map<number, TestEvseContext> }).evseContexts;
  contexts.set(evseId, {
    state: 'Charging',
    authorizedToken: 'TAG-1',
    authorizedTokenType: 'ISO14443',
    transactionId: 'tx-1',
    remoteStartId: null,
    cablePlugged: true,
  });
  (sim as unknown as { evseConnectorStatus: Map<number, string> }).evseConnectorStatus.set(
    evseId,
    'Charging',
  );
}

function makeConfig(protocol: 'ocpp1.6' | 'ocpp2.1'): StationConfig {
  return {
    id: 'css_test',
    stationId: 'TEST-001',
    ocppProtocol: protocol,
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
}

function makeSimulator(
  protocol: 'ocpp1.6' | 'ocpp2.1',
  sql: postgres.Sql = noopSql(),
): StationSimulator {
  const sim = new StationSimulator(makeConfig(protocol), sql);
  const sendCall = vi.fn(async () => ({ status: 'Accepted' }));
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  Object.defineProperty(sim.client, 'disconnect', { value: vi.fn(), writable: true });
  Object.defineProperty(sim.client, 'isConnected', { value: true, writable: true });
  return sim;
}

async function stopTransaction(sim: StationSimulator, evseId: number): Promise<void> {
  await (
    sim as unknown as { stopCharging: (evseId: number, reason?: string) => Promise<void> }
  ).stopCharging(evseId, 'Remote');
}

function getSendCallSpy(sim: StationSimulator): ReturnType<typeof vi.fn> {
  return sim.client.sendCall as unknown as ReturnType<typeof vi.fn>;
}

// The wire status field differs by version: 1.6 uses `status`, 2.1 uses
// `connectorStatus`. Return the last StatusNotification's reported status.
function lastReportedStatus(sim: StationSimulator, is16: boolean): string | undefined {
  const calls = getSendCallSpy(sim).mock.calls as Array<[string, Record<string, unknown>]>;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call != null && call[0] === 'StatusNotification') {
      return (is16 ? call[1]['status'] : call[1]['connectorStatus']) as string;
    }
  }
  return undefined;
}

function trackedStatus(sim: StationSimulator, evseId: number): string | undefined {
  return (sim as unknown as { evseConnectorStatus: Map<number, string> }).evseConnectorStatus.get(
    evseId,
  );
}

async function invoke(
  sim: StationSimulator,
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = (
    sim as unknown as {
      handleCsmsCommand: (
        id: string,
        action: string,
        payload: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    }
  ).handleCsmsCommand;
  return handler.call(sim, 'm1', action, payload);
}

describe('clampStatusForAdminAvailability', () => {
  it('passes any status through when not administratively unavailable', () => {
    expect(clampStatusForAdminAvailability('Available', false)).toBe('Available');
    expect(clampStatusForAdminAvailability('Charging', false)).toBe('Charging');
    expect(clampStatusForAdminAvailability('Unavailable', false)).toBe('Unavailable');
  });

  it('clamps contradicting statuses down to Unavailable when admin-down', () => {
    expect(clampStatusForAdminAvailability('Available', true)).toBe('Unavailable');
    expect(clampStatusForAdminAvailability('Occupied', true)).toBe('Unavailable');
    expect(clampStatusForAdminAvailability('Charging', true)).toBe('Unavailable');
    expect(clampStatusForAdminAvailability('Preparing', true)).toBe('Unavailable');
  });

  it('lets Unavailable and Faulted pass through even when admin-down', () => {
    expect(clampStatusForAdminAvailability('Unavailable', true)).toBe('Unavailable');
    expect(clampStatusForAdminAvailability('Faulted', true)).toBe('Faulted');
  });
});

describe('dispatchStatusNotification respects administrative availability (OCPP 2.1)', () => {
  it('clamps a requested Available to Unavailable after ChangeAvailability(Inoperative)', async () => {
    const sim = makeSimulator('ocpp2.1');

    const res = await invoke(sim, 'ChangeAvailability', { operationalStatus: 'Inoperative' });
    expect(res['status']).toBe('Accepted');
    getSendCallSpy(sim).mockClear();

    await sim.dispatchStatusNotification(1, 1, 'Available');

    expect(lastReportedStatus(sim, false)).toBe('Unavailable');
    expect(trackedStatus(sim, 1)).toBe('Unavailable');
  });

  it('lets Available pass through after ChangeAvailability(Operative) is restored', async () => {
    const sim = makeSimulator('ocpp2.1');

    await invoke(sim, 'ChangeAvailability', { operationalStatus: 'Inoperative' });
    const res = await invoke(sim, 'ChangeAvailability', { operationalStatus: 'Operative' });
    expect(res['status']).toBe('Accepted');
    getSendCallSpy(sim).mockClear();

    await sim.dispatchStatusNotification(1, 1, 'Available');

    expect(lastReportedStatus(sim, false)).toBe('Available');
    expect(trackedStatus(sim, 1)).toBe('Available');
  });

  it('still lets Faulted through while administratively inoperative', async () => {
    const sim = makeSimulator('ocpp2.1');

    await invoke(sim, 'ChangeAvailability', { operationalStatus: 'Inoperative' });
    getSendCallSpy(sim).mockClear();

    await sim.dispatchStatusNotification(1, 1, 'Faulted', 'InternalError');

    expect(lastReportedStatus(sim, false)).toBe('Faulted');
    expect(trackedStatus(sim, 1)).toBe('Faulted');
  });
});

describe('dispatchStatusNotification respects administrative availability (OCPP 1.6)', () => {
  it('clamps a requested Available to Unavailable after ChangeAvailability(Inoperative)', async () => {
    const sim = makeSimulator('ocpp1.6');

    const res = await invoke(sim, 'ChangeAvailability', { type: 'Inoperative', connectorId: 1 });
    expect(res['status']).toBe('Accepted');
    getSendCallSpy(sim).mockClear();

    await sim.dispatchStatusNotification(1, 1, 'Available');

    expect(lastReportedStatus(sim, true)).toBe('Unavailable');
    expect(trackedStatus(sim, 1)).toBe('Unavailable');
  });

  it('lets Available pass through after ChangeAvailability(Operative) is restored', async () => {
    const sim = makeSimulator('ocpp1.6');

    await invoke(sim, 'ChangeAvailability', { type: 'Inoperative', connectorId: 1 });
    const res = await invoke(sim, 'ChangeAvailability', { type: 'Operative', connectorId: 1 });
    expect(res['status']).toBe('Accepted');
    getSendCallSpy(sim).mockClear();

    await sim.dispatchStatusNotification(1, 1, 'Available');

    expect(lastReportedStatus(sim, true)).toBe('Available');
    expect(trackedStatus(sim, 1)).toBe('Available');
  });
});

describe('scheduled ChangeAvailability applies when the transaction ends (OCPP 2.1)', () => {
  it('returns Scheduled while a transaction is active, then rests at Unavailable after stop', async () => {
    const sim = makeSimulator('ocpp2.1', txAwareSql());
    startInMemoryTransaction(sim, 1);

    const res = await invoke(sim, 'ChangeAvailability', { operationalStatus: 'Inoperative' });
    expect(res['status']).toBe('Scheduled');
    getSendCallSpy(sim).mockClear();

    await stopTransaction(sim, 1);

    expect(lastReportedStatus(sim, false)).toBe('Unavailable');
    expect(trackedStatus(sim, 1)).toBe('Unavailable');
  });

  it('restores to Available after ChangeAvailability(Operative)', async () => {
    const sim = makeSimulator('ocpp2.1', txAwareSql());
    startInMemoryTransaction(sim, 1);

    await invoke(sim, 'ChangeAvailability', { operationalStatus: 'Inoperative' });
    await stopTransaction(sim, 1);
    expect(trackedStatus(sim, 1)).toBe('Unavailable');

    const res = await invoke(sim, 'ChangeAvailability', { operationalStatus: 'Operative' });
    expect(res['status']).toBe('Accepted');

    expect(lastReportedStatus(sim, false)).toBe('Available');
    expect(trackedStatus(sim, 1)).toBe('Available');
  });
});

describe('scheduled ChangeAvailability applies when the transaction ends (OCPP 1.6)', () => {
  it('returns Scheduled while a transaction is active, then rests at Unavailable after stop', async () => {
    const sim = makeSimulator('ocpp1.6', txAwareSql());
    startInMemoryTransaction(sim, 1);

    const res = await invoke(sim, 'ChangeAvailability', { type: 'Inoperative', connectorId: 1 });
    expect(res['status']).toBe('Scheduled');
    getSendCallSpy(sim).mockClear();

    await stopTransaction(sim, 1);

    expect(lastReportedStatus(sim, true)).toBe('Unavailable');
    expect(trackedStatus(sim, 1)).toBe('Unavailable');
  });

  it('restores to Available after ChangeAvailability(Operative)', async () => {
    const sim = makeSimulator('ocpp1.6', txAwareSql());
    startInMemoryTransaction(sim, 1);

    await invoke(sim, 'ChangeAvailability', { type: 'Inoperative', connectorId: 1 });
    await stopTransaction(sim, 1);
    expect(trackedStatus(sim, 1)).toBe('Unavailable');

    const res = await invoke(sim, 'ChangeAvailability', { type: 'Operative', connectorId: 1 });
    expect(res['status']).toBe('Accepted');

    expect(lastReportedStatus(sim, true)).toBe('Available');
    expect(trackedStatus(sim, 1)).toBe('Available');
  });
});
