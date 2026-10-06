// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OcppClient, type ReconnectBackOff } from '../ocpp-client.js';
import { StationSimulator } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';
import { makeHarness, priv, silenceConsole, stubSql, type SqlResponder } from './sim-harness.js';

interface Recorded {
  query: string;
  values: unknown[];
}

function recordingSql(responder?: SqlResponder): {
  sql: ReturnType<typeof stubSql>;
  queries: Recorded[];
} {
  const queries: Recorded[] = [];
  const sql = stubSql((query, values) => {
    queries.push({ query, values });
    return responder?.(query, values);
  });
  return { sql, queries };
}

type ClientInternals = {
  onIncomingCall: (
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  onConnectedCallback: () => void;
  onDisconnectedCallback: () => void;
  reconnectBackOff: (() => ReconnectBackOff | null) | null;
  beforeReconnectAttempt: (attempt: number) => void;
  onServerCertificateRejected: (err: Error) => void;
  onTlsVersionRejected: (err: Error) => void;
};

function internals(sim: StationSimulator): ClientInternals {
  return sim.client as unknown as ClientInternals;
}

function offlineQueue(
  sim: StationSimulator,
): Array<{ action: string; payload: Record<string, unknown> }> {
  return (
    sim as unknown as {
      offlineMessageQueue: Array<{ action: string; payload: Record<string, unknown> }>;
    }
  ).offlineMessageQueue;
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('persisted caches load from the database', () => {
  const hourAgo = new Date(Date.now() - 3_600_000);
  const longAgo = new Date(Date.now() - 10 * 86_400_000);

  function rows(query: string): unknown[] | undefined {
    if (query.includes('FROM css_installed_certificates')) {
      return [
        {
          certificate_type: 'CSMSRootCertificate',
          hash_algorithm: 'SHA256',
          issuer_name_hash: null,
          issuer_key_hash: 'kh',
          serial_number: 'SER-1',
          certificate: null,
        },
        {
          certificate_type: 'V2GCertificateChain',
          hash_algorithm: 'SHA256',
          issuer_name_hash: 'nh',
          issuer_key_hash: null,
          serial_number: 'SER-2',
          certificate: 'PEM',
        },
      ];
    }
    if (query.includes('FROM css_charging_profiles')) {
      return [{ profile_id: 7, evse_id: 1, profile_data: { id: 7, stackLevel: 0 } }];
    }
    if (query.includes('FROM css_display_messages')) {
      return [{ message_id: 3, message_data: { id: 3, priority: 'NormalCycle' } }];
    }
    if (query.includes('FROM css_local_auth_entries')) {
      return [
        {
          id_token: 'LOCAL-1',
          token_type: 'ISO14443',
          auth_status: 'Accepted',
          list_version: 4,
          entry_data: null,
        },
        {
          id_token: 'LOCAL-2',
          token_type: 'eMAID',
          auth_status: 'Blocked',
          list_version: 9,
          entry_data: { idToken: { idToken: 'LOCAL-2' } },
        },
      ];
    }
    if (query.includes('FROM css_variable_monitors')) {
      return [
        { monitor_id: 41, monitor_data: { id: 41, isHardwired: false } },
        { monitor_id: 5, monitor_data: { id: 5, isHardwired: false } },
      ];
    }
    if (query.includes('FROM css_auth_cache')) {
      return [
        { id_token: 'FRESH', id_token_info: { status: 'Accepted' }, cached_at: hourAgo },
        { id_token: 'STALE', id_token_info: { status: 'Accepted' }, cached_at: longAgo },
      ];
    }
    return undefined;
  }

  it('maps every stored row into its cache', async () => {
    const h = await makeHarness({ sql: stubSql(rows) });
    const certs = priv(h, 'installedCertificatesCache') as Map<string, Record<string, unknown>>;
    expect(certs.size).toBe(2);
    expect(certs.get('SER-1')).toEqual({
      certificateType: 'CSMSRootCertificate',
      certificateHashData: {
        hashAlgorithm: 'SHA256',
        issuerNameHash: '',
        issuerKeyHash: 'kh',
        serialNumber: 'SER-1',
      },
    });
    expect(certs.get('SER-2')).toMatchObject({ certificate: 'PEM' });

    const profiles = priv(h, 'chargingProfilesCache') as Map<number, Record<string, unknown>>;
    expect(profiles.get(7)).toEqual({ id: 7, stackLevel: 0, _evseId: 1 });

    const messages = priv(h, 'displayMessagesCache') as Map<number, Record<string, unknown>>;
    expect(messages.get(3)).toEqual({ id: 3, priority: 'NormalCycle' });

    const local = priv(h, 'localAuthEntries') as Map<string, Record<string, unknown>>;
    expect(local.get('LOCAL-1')).toEqual({ authStatus: 'Accepted', tokenType: 'ISO14443' });
    expect(local.get('LOCAL-2')).toEqual({
      idToken: { idToken: 'LOCAL-2' },
      authStatus: 'Blocked',
      tokenType: 'eMAID',
    });
    // The list version continues from the highest stored version.
    expect(priv(h, 'localAuthListVersion')).toBe(9);

    // Monitor ids continue after the highest stored, non-hardwired monitor.
    expect(priv(h, 'monitorIdCounter')).toBe(41);

    // Cached tokens older than AuthCacheCtrlr.LifeTime are dropped on load.
    const cache = priv(h, 'authCache') as Map<string, Record<string, unknown>>;
    expect(cache.has('FRESH')).toBe(true);
    expect(cache.has('STALE')).toBe(false);
  });

  it('GetInstalledCertificateIds 2.1 lists the loaded certificates with a V2G child entry', async () => {
    const h = await makeHarness({ sql: stubSql(rows) });
    const all = await h.invoke('GetInstalledCertificateIds', {});
    expect(all['status']).toBe('Accepted');
    const chain = all['certificateHashDataChain'] as Array<Record<string, unknown>>;
    expect(chain).toHaveLength(2);
    const v2g = chain.find((c) => c['certificateType'] === 'V2GCertificateChain');
    expect(v2g?.['childCertificateHashData']).toEqual([
      {
        hashAlgorithm: 'SHA256',
        issuerNameHash: 'nh',
        issuerKeyHash: '',
        serialNumber: 'SER-2-child',
      },
    ]);

    const filtered = await h.invoke('GetInstalledCertificateIds', {
      certificateType: ['CSMSRootCertificate'],
    });
    expect(filtered['certificateHashDataChain']).toHaveLength(1);

    const none = await h.invoke('GetInstalledCertificateIds', {
      certificateType: ['MORootCertificate'],
    });
    expect(none).toEqual({ status: 'NotFound' });
  });

  it('cache clears and removals delete the stored rows', async () => {
    const { sql, queries } = recordingSql(rows);
    const h = await makeHarness({ sql });
    queries.length = 0;
    const names = [
      'installedCertificatesCache',
      'chargingProfilesCache',
      'displayMessagesCache',
      'localAuthEntries',
      'variableMonitors',
      'customerDataStore',
      'authCache',
    ];
    for (const name of names) {
      (priv(h, name) as { clear: () => void }).clear();
    }
    const config = priv(h, 'configVariables') as Map<string, { value: string; readonly: boolean }>;
    config.set('X.Y', { value: '1', readonly: false });
    config.delete('X.Y');
    (priv(h, 'localAuthEntries') as { set: (k: string, v: unknown) => void }).set('T', {
      authStatus: 'Accepted',
    });
    (priv(h, 'localAuthEntries') as { delete: (k: string) => boolean }).delete('T');
    await vi.advanceTimersByTimeAsync(0);

    const deletes = queries.map((q) => q.query).filter((q) => q.includes('DELETE FROM'));
    for (const table of [
      'css_installed_certificates',
      'css_charging_profiles',
      'css_display_messages',
      'css_local_auth_entries',
      'css_variable_monitors',
      'css_customer_data',
      'css_auth_cache',
      'css_config_variables',
    ]) {
      expect(deletes.some((q) => q.includes(table))).toBe(true);
    }
  });

  it('a failing load is logged and the cache starts empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = ((strings: TemplateStringsArray) => {
      const q = strings.join(' ');
      if (q.includes('FROM css_display_messages')) return Promise.reject(new Error('db down'));
      return Promise.resolve([]);
    }) as unknown as ReturnType<typeof stubSql>;
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    const h = await makeHarness({ sql });
    expect((priv(h, 'displayMessagesCache') as Map<number, unknown>).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[TEST-SIM] PersistedCache displayMessagesCache load failed'),
      { err: 'db down' },
    );
  });
});

describe('client wiring', () => {
  it('routes CSMS calls through the incoming call handler', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const res = await internals(h.sim).onIncomingCall('m1', 'GetLocalListVersion', {});
    expect(res).toEqual(expect.objectContaining({ listVersion: expect.any(Number) }));
  });

  it('records the BootNotification status from any BootNotification call', async () => {
    const spy = vi
      .spyOn(OcppClient.prototype, 'sendCall')
      .mockResolvedValue({ status: 'Pending', interval: 10 });
    const sim = new StationSimulator(makeConfig(), stubSql());
    const res = await sim.client.sendCall('BootNotification', { reason: 'PowerUp' });
    expect(res).toEqual({ status: 'Pending', interval: 10 });
    expect(spy).toHaveBeenCalledWith('BootNotification', { reason: 'PowerUp' });
    expect((sim as unknown as { bootStatus: string }).bootStatus).toBe('Pending');

    spy.mockResolvedValue({ currentTime: 'now' });
    await sim.client.sendCall('Heartbeat', {});
    expect((sim as unknown as { bootStatus: string }).bootStatus).toBe('Pending');
  });

  it('2.1: the reconnect back-off follows OCPPCommCtrlr.RetryBackOff*', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('OCPPCommCtrlr.RetryBackOffWaitMinimum', '7');
    h.sim.setConfigValue('OCPPCommCtrlr.RetryBackOffRandomRange', '3');
    h.sim.setConfigValue('OCPPCommCtrlr.RetryBackOffRepeatTimes', '-1');
    const backOff = internals(h.sim).reconnectBackOff?.();
    expect(backOff?.waitMinimumMs).toBe(7000);
    expect(backOff?.randomRangeMs).toBe(3000);
    // A negative value is invalid: the default applies.
    expect(backOff?.repeatTimes).toBeGreaterThanOrEqual(0);
  });

  it('1.6 has no device-model back-off', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(internals(h.sim).reconnectBackOff).toBeNull();
  });

  it('a disconnect marks the station offline once and stores the delivered statuses', async () => {
    const { sql, queries } = recordingSql();
    const h = await makeHarness({ sql });
    (priv(h, 'deliveredConnectorStatus') as Map<number, string>).set(1, 'Occupied');
    queries.length = 0;
    internals(h.sim).onDisconnectedCallback();
    const since = priv(h, 'offlineSince');
    expect(since).toEqual(expect.any(Number));
    expect(priv(h, 'statusesAtDisconnect')).toEqual(new Map([[1, 'Occupied']]));
    await vi.advanceTimersByTimeAsync(0);
    expect(queries.some((q) => q.values.includes('disconnected'))).toBe(true);

    vi.advanceTimersByTime(5000);
    internals(h.sim).onDisconnectedCallback();
    expect(priv(h, 'offlineSince')).toBe(since);
  });

  it.each([
    ['ocpp2.1', 'InvalidCsmsCertificate'],
    ['ocpp1.6', 'InvalidCentralSystemCertificate'],
  ] as const)('%s: a refused server certificate queues %s', async (protocol, type) => {
    const h = await makeHarness({ protocol });
    internals(h.sim).onServerCertificateRejected(new Error('self signed'));
    expect(offlineQueue(h.sim).at(-1)).toMatchObject({
      action: 'SecurityEventNotification',
      payload: { type, techInfo: 'self signed' },
    });
  });

  it('2.1 queues InvalidTLSVersion for a refused TLS version, 1.6 does not', async () => {
    const h21 = await makeHarness();
    internals(h21.sim).onTlsVersionRejected(new Error('unsupported protocol'));
    expect(offlineQueue(h21.sim).at(-1)).toMatchObject({
      action: 'SecurityEventNotification',
      payload: { type: 'InvalidTLSVersion', techInfo: 'unsupported protocol' },
    });

    const h16 = await makeHarness({ protocol: 'ocpp1.6' });
    const before = offlineQueue(h16.sim).length;
    internals(h16.sim).onTlsVersionRejected(new Error('unsupported protocol'));
    expect(offlineQueue(h16.sim)).toHaveLength(before);
  });

  it('isConnected mirrors the client', async () => {
    const h = await makeHarness({ connected: false });
    expect(h.sim.isConnected).toBe(false);
    Object.defineProperty(h.sim.client, 'isConnected', { value: true, writable: true });
    expect(h.sim.isConnected).toBe(true);
  });
});
