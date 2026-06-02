// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator, type StationConfig } from '../station-simulator.js';
import type { PersistedCache } from '../lib/persisted-cache.js';

// Tagged-template no-op SQL stub. Returns an empty array for any query so
// persistor upsert/remove/clear calls succeed silently. The PersistedCache
// pattern is what matters; the actual DB write is asserted via the cache
// in-memory map.
function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
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

function makeSimulator(): StationSimulator {
  const sim = new StationSimulator(makeConfig(), noopSql());
  const sendCall = vi.fn(async () => ({ status: 'Accepted' }));
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  Object.defineProperty(sim.client, 'disconnect', { value: vi.fn(), writable: true });
  return sim;
}

// Invoke the private handler. Test-time cast only.
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

function cacheOf<K, V>(sim: StationSimulator, name: string): PersistedCache<K, V> {
  const c = (sim as unknown as Record<string, PersistedCache<K, V>>)[name];
  if (c == null) throw new Error(`cache "${name}" not found on simulator`);
  return c;
}

describe('StationSimulator handler ↔ cache wiring (OCPP 2.1)', () => {
  describe('SetVariables', () => {
    it('Accepted: persists the new value through configVariables cache', async () => {
      const sim = makeSimulator();
      const configVariables = cacheOf<string, { value: string; readonly: boolean }>(
        sim,
        'configVariables',
      );
      // Seed a writable variable so SetVariables can accept it.
      configVariables.set('OCPPCommCtrlr.HeartbeatInterval', { value: '300', readonly: false });

      const res = await invoke(sim, 'SetVariables', {
        setVariableData: [
          {
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'HeartbeatInterval' },
            attributeValue: '600',
          },
        ],
      });

      const results = res['setVariableResult'] as Array<{ attributeStatus: string }>;
      expect(results[0]?.attributeStatus).toBe('Accepted');
      expect(configVariables.get('OCPPCommCtrlr.HeartbeatInterval')?.value).toBe('600');
    });

    it('Rejected (readonly): does not mutate configVariables', async () => {
      const sim = makeSimulator();
      const configVariables = cacheOf<string, { value: string; readonly: boolean }>(
        sim,
        'configVariables',
      );
      configVariables.set('ChargingStation.Model', { value: 'TestModel', readonly: true });

      const res = await invoke(sim, 'SetVariables', {
        setVariableData: [
          {
            component: { name: 'ChargingStation' },
            variable: { name: 'Model' },
            attributeValue: 'Hacked',
          },
        ],
      });

      const results = res['setVariableResult'] as Array<{ attributeStatus: string }>;
      expect(results[0]?.attributeStatus).toBe('Rejected');
      expect(configVariables.get('ChargingStation.Model')?.value).toBe('TestModel');
    });

    it('UnknownComponent: returns the right status without touching the cache', async () => {
      const sim = makeSimulator();
      const configVariables = cacheOf<string, { value: string; readonly: boolean }>(
        sim,
        'configVariables',
      );
      const sizeBefore = configVariables.size;

      const res = await invoke(sim, 'SetVariables', {
        setVariableData: [
          {
            component: { name: 'TotallyMadeUpComponent' },
            variable: { name: 'AnyVar' },
            attributeValue: 'x',
          },
        ],
      });

      const results = res['setVariableResult'] as Array<{ attributeStatus: string }>;
      expect(results[0]?.attributeStatus).toBe('UnknownComponent');
      expect(configVariables.size).toBe(sizeBefore);
    });
  });

  describe('SetVariables with per-EVSE Connector scope', () => {
    it('resolves the scoped key Connector[1,1].ConnectorType via the component.evse binding', async () => {
      const sim = makeSimulator();
      const configVariables = cacheOf<string, { value: string; readonly: boolean }>(
        sim,
        'configVariables',
      );
      // Seed as readonly per spec; SetVariables should be Rejected, not UnknownVariable.
      configVariables.set('Connector[1,1].ConnectorType', { value: 'cType2', readonly: true });

      const res = await invoke(sim, 'SetVariables', {
        setVariableData: [
          {
            component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
            variable: { name: 'ConnectorType' },
            attributeValue: 'cCCS2',
          },
        ],
      });

      const results = res['setVariableResult'] as Array<{ attributeStatus: string }>;
      expect(results[0]?.attributeStatus).toBe('Rejected');
    });
  });

  describe('SetDisplayMessage', () => {
    it('Accepted: writes to displayMessagesCache', async () => {
      const sim = makeSimulator();
      const cache = cacheOf<number, Record<string, unknown>>(sim, 'displayMessagesCache');

      const res = await invoke(sim, 'SetDisplayMessage', {
        message: {
          id: 42,
          priority: 'NormalCycle',
          state: 'Idle',
          message: { format: 'UTF8', content: 'Hi' },
        },
      });

      expect(res['status']).toBe('Accepted');
      expect(cache.get(42)).toBeTruthy();
    });
  });

  describe('ClearDisplayMessage', () => {
    it('removes the matching id from displayMessagesCache', async () => {
      const sim = makeSimulator();
      const cache = cacheOf<number, Record<string, unknown>>(sim, 'displayMessagesCache');
      cache.set(7, { id: 7 });

      const res = await invoke(sim, 'ClearDisplayMessage', { id: 7 });

      expect(res['status']).toBe('Accepted');
      expect(cache.has(7)).toBe(false);
    });

    it('returns Unknown for a missing id and does not mutate the cache', async () => {
      const sim = makeSimulator();
      const cache = cacheOf<number, Record<string, unknown>>(sim, 'displayMessagesCache');

      const res = await invoke(sim, 'ClearDisplayMessage', { id: 999 });

      expect(res['status']).toBe('Unknown');
      expect(cache.size).toBe(0);
    });
  });

  describe('InstallCertificate / DeleteCertificate', () => {
    it('InstallCertificate writes to installedCertificatesCache', async () => {
      const sim = makeSimulator();
      const cache = cacheOf<
        string,
        { certificateType: string; certificateHashData: Record<string, string> }
      >(sim, 'installedCertificatesCache');
      const before = cache.size;

      const res = await invoke(sim, 'InstallCertificate', {
        certificateType: 'V2GRootCertificate',
        certificate: 'MIIvalidCertPayloadXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      });

      expect(res['status']).toBe('Accepted');
      expect(cache.size).toBe(before + 1);
    });

    it('DeleteCertificate removes the entry by serial from installedCertificatesCache', async () => {
      const sim = makeSimulator();
      const cache = cacheOf<
        string,
        { certificateType: string; certificateHashData: Record<string, string> }
      >(sim, 'installedCertificatesCache');
      cache.set('abc123', {
        certificateType: 'V2GRootCertificate',
        certificateHashData: { hashAlgorithm: 'SHA256', serialNumber: 'abc123' },
      });

      const res = await invoke(sim, 'DeleteCertificate', {
        certificateHashData: { serialNumber: 'abc123' },
      });

      expect(res['status']).toBe('Accepted');
      expect(cache.has('abc123')).toBe(false);
    });

    it('DeleteCertificate refuses to delete CSMSRootCertificate', async () => {
      const sim = makeSimulator();
      const cache = cacheOf<
        string,
        { certificateType: string; certificateHashData: Record<string, string> }
      >(sim, 'installedCertificatesCache');
      cache.set('root', {
        certificateType: 'CSMSRootCertificate',
        certificateHashData: { hashAlgorithm: 'SHA256', serialNumber: 'root' },
      });

      const res = await invoke(sim, 'DeleteCertificate', {
        certificateHashData: { serialNumber: 'root' },
      });

      expect(res['status']).toBe('Failed');
      expect(cache.has('root')).toBe(true);
    });
  });

  describe('SendLocalList', () => {
    it('Full update writes entries to localAuthEntries and bumps localAuthListVersion', async () => {
      const sim = makeSimulator();
      const cache = cacheOf<string, Record<string, unknown>>(sim, 'localAuthEntries');

      const res = await invoke(sim, 'SendLocalList', {
        versionNumber: 5,
        updateType: 'Full',
        localAuthorizationList: [
          {
            idToken: { idToken: 'CARD-001', type: 'ISO14443' },
            idTokenInfo: { status: 'Accepted' },
          },
          {
            idToken: { idToken: 'CARD-002', type: 'ISO14443' },
            idTokenInfo: { status: 'Accepted' },
          },
        ],
      });

      expect(res['status']).toBe('Accepted');
      expect(cache.size).toBe(2);
      expect(cache.has('CARD-001')).toBe(true);
      expect(cache.has('CARD-002')).toBe(true);
      const version = (sim as unknown as { localAuthListVersion: number }).localAuthListVersion;
      expect(version).toBe(5);
    });

    it('rejects Differential update when listVersion <= current', async () => {
      const sim = makeSimulator();
      (sim as unknown as { localAuthListVersion: number }).localAuthListVersion = 10;

      const res = await invoke(sim, 'SendLocalList', {
        versionNumber: 5,
        updateType: 'Differential',
        localAuthorizationList: [],
      });

      expect(res['status']).toBe('VersionMismatch');
    });
  });
});
