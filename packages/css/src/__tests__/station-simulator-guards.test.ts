// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator, type StationConfig } from '../station-simulator.js';

// Tagged-template no-op SQL stub. Returns an empty array for any query so
// updateStationStatus / updateEvseStatus calls succeed silently.
function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  return fn;
}

function makeConfig(): StationConfig {
  return {
    id: 'css_test',
    stationId: 'TEST-001',
    ocppProtocol: 'ocpp2.1',
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

// Build a simulator with all network/DB side effects stubbed out so we can
// exercise the action guards without a real OCPP server or postgres pool.
function makeSimulator(): StationSimulator {
  const sim = new StationSimulator(makeConfig(), noopSql());
  // Replace client.sendCall so we can spy on it (and so calls don't throw)
  const sendCall = vi.fn(async () => ({ status: 'Accepted' }));
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  Object.defineProperty(sim.client, 'disconnect', { value: vi.fn(), writable: true });
  return sim;
}

function getSendCallSpy(sim: StationSimulator): ReturnType<typeof vi.fn> {
  return sim.client.sendCall as unknown as ReturnType<typeof vi.fn>;
}

function getEvseContext(
  sim: StationSimulator,
  evseId: number,
): {
  state: string;
  cablePlugged: boolean;
  transactionId: string | null;
  authorizedToken: string | null;
  authorizedTokenType: string | null;
  remoteStartId: number | null;
} {
  // Internal map; access via cast for test setup only.
  return (
    sim as unknown as { evseContexts: Map<number, ReturnType<typeof getEvseContext>> }
  ).evseContexts.get(evseId) as ReturnType<typeof getEvseContext>;
}

function setConnectorStatus(sim: StationSimulator, evseId: number, status: string): void {
  (sim as unknown as { evseConnectorStatus: Map<number, string> }).evseConnectorStatus.set(
    evseId,
    status,
  );
}

function setOfflineFlag(sim: StationSimulator, value: boolean): void {
  (sim as unknown as { offlineFlag: boolean }).offlineFlag = value;
}

function setClientConnected(sim: StationSimulator, connected: boolean): void {
  Object.defineProperty(sim.client, 'isConnected', { get: () => connected, configurable: true });
}

describe('StationSimulator action guards', () => {
  describe('unplug', () => {
    it('no-ops when no cable is plugged, no active transaction, and connector is already Available', async () => {
      const sim = makeSimulator();
      const ctx = getEvseContext(sim, 1);
      ctx.cablePlugged = false;
      ctx.transactionId = null;
      setConnectorStatus(sim, 1, 'Available');
      const sendCall = getSendCallSpy(sim);

      await sim.unplug(1);

      expect(sendCall).not.toHaveBeenCalled();
    });

    it('proceeds when connector reports Finishing even if in-memory cable state is unset', async () => {
      // Reproduces the post-restart drift case: simulator restarts and resets
      // its in-memory map to cable=false / tx=null, but the CSMS still holds
      // the connector at Finishing from the previous session. Unplug must
      // proceed so a StatusNotification(Available) clears it.
      const sim = makeSimulator();
      const ctx = getEvseContext(sim, 1);
      ctx.cablePlugged = false;
      ctx.transactionId = null;
      setConnectorStatus(sim, 1, 'Finishing');
      const sendCall = getSendCallSpy(sim);

      await sim.unplug(1);

      expect(sendCall).toHaveBeenCalled();
    });

    it('proceeds when cable is plugged (Finishing -> Available transition)', async () => {
      const sim = makeSimulator();
      const ctx = getEvseContext(sim, 1);
      ctx.cablePlugged = true;
      ctx.transactionId = null;
      setConnectorStatus(sim, 1, 'Finishing');
      const sendCall = getSendCallSpy(sim);

      await sim.unplug(1);

      // Should send a StatusNotification(Available)
      expect(sendCall).toHaveBeenCalled();
      expect(ctx.cablePlugged).toBe(false);
    });
  });

  describe('injectFault', () => {
    it('no-ops when connector is already Faulted', async () => {
      const sim = makeSimulator();
      setConnectorStatus(sim, 1, 'Faulted');
      const sendCall = getSendCallSpy(sim);

      await sim.injectFault(1, 'InternalError');

      expect(sendCall).not.toHaveBeenCalled();
    });

    it('proceeds when connector is Available', async () => {
      const sim = makeSimulator();
      setConnectorStatus(sim, 1, 'Available');
      const sendCall = getSendCallSpy(sim);

      await sim.injectFault(1, 'InternalError');

      expect(sendCall).toHaveBeenCalled();
    });
  });

  describe('clearFault', () => {
    it('no-ops when connector is not Faulted', async () => {
      const sim = makeSimulator();
      setConnectorStatus(sim, 1, 'Available');
      const sendCall = getSendCallSpy(sim);

      await sim.clearFault(1);

      expect(sendCall).not.toHaveBeenCalled();
    });

    it('proceeds when connector is Faulted', async () => {
      const sim = makeSimulator();
      setConnectorStatus(sim, 1, 'Faulted');
      const sendCall = getSendCallSpy(sim);

      await sim.clearFault(1);

      expect(sendCall).toHaveBeenCalled();
    });
  });

  describe('goOffline', () => {
    it('no-ops when already offline', async () => {
      const sim = makeSimulator();
      setOfflineFlag(sim, true);
      const disconnect = sim.client.disconnect as unknown as ReturnType<typeof vi.fn>;

      await sim.goOffline();

      expect(disconnect).not.toHaveBeenCalled();
    });

    it('proceeds when online', async () => {
      const sim = makeSimulator();
      setOfflineFlag(sim, false);
      const disconnect = sim.client.disconnect as unknown as ReturnType<typeof vi.fn>;

      await sim.goOffline();

      expect(disconnect).toHaveBeenCalled();
      expect((sim as unknown as { offlineFlag: boolean }).offlineFlag).toBe(true);
    });
  });

  describe('comeOnline', () => {
    it('no-ops when already online and connected', async () => {
      const sim = makeSimulator();
      setOfflineFlag(sim, false);
      setClientConnected(sim, true);
      // start() would throw without a real server - if comeOnline tries to call
      // it, this test would fail with a connect error.
      await sim.comeOnline();

      expect((sim as unknown as { offlineFlag: boolean }).offlineFlag).toBe(false);
    });
  });

  describe('plugIn (existing guard)', () => {
    it('no-ops when cable is plugged and a transaction is active', async () => {
      const sim = makeSimulator();
      const ctx = getEvseContext(sim, 1);
      ctx.cablePlugged = true;
      ctx.transactionId = 'tx-123';
      const sendCall = getSendCallSpy(sim);

      await sim.plugIn(1);

      expect(sendCall).not.toHaveBeenCalled();
    });
  });
});
