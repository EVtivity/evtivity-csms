// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeHarness,
  priv,
  silenceConsole,
  stubSql,
  type CallResponder,
  type Harness,
  type Protocol,
} from './sim-harness.js';
import { makeConfig } from './sim-test-helpers.js';
import type { StationConfig } from '../station-simulator.js';

// css_transactions reads follow the in-memory transactions, as the real table would.
async function liveHarness(
  protocol: Protocol,
  respond?: CallResponder,
  evses?: ReturnType<typeof makeConfig>['evses'],
): Promise<Harness> {
  let ref: Harness | null = null;
  const sql = stubSql((q, values) => {
    if (ref == null || !q.includes('SELECT transaction_id, meter_start_wh, id_token')) {
      return undefined;
    }
    const evseId = values[1] as number;
    const txId = (priv(ref, 'activeTransactionIds') as Map<number, string>).get(evseId);
    return txId == null ? [] : [{ transaction_id: txId, meter_start_wh: 0, id_token: 'TAG' }];
  });
  const h = await makeHarness({
    protocol,
    sql,
    boot: true,
    ...(respond ? { respond } : {}),
    ...(evses ? { config: { evses } } : {}),
  });
  ref = h;
  h.sendCall.mockClear();
  return h;
}

type ConfigMap = Map<string, { value: string; readonly: boolean }>;

function config(h: Harness): ConfigMap {
  return priv(h, 'configVariables') as ConfigMap;
}

function setVar(h: Harness, key: string, value: string, readonly = false): void {
  config(h).set(key, { value, readonly });
}

const TWO_EVSES = [
  {
    evseId: 1,
    connectorId: 1,
    connectorType: 'ac_type2',
    maxPowerW: 22000,
    phases: 3,
    voltage: 230,
  },
  {
    evseId: 2,
    connectorId: 1,
    connectorType: 'dc_ccs2',
    maxPowerW: 50000,
    phases: 3,
    voltage: 400,
  },
] satisfies StationConfig['evses'];

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RequestStartTransaction (F01/F02)', () => {
  it('plugged EVSE with AuthorizeRemoteStart=false: stores the profile and starts without Authorize', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    h.sim.setConfigValue('AuthCtrlr.AuthorizeRemoteStart', 'false');
    h.sendCall.mockClear();
    const res = await h.invoke('RequestStartTransaction', {
      remoteStartId: 77,
      idToken: { idToken: 'REMOTE-1', type: 'Central' },
      evseId: 1,
      chargingProfile: { id: 31, stackLevel: 0, chargingProfilePurpose: 'TxProfile' },
    });
    expect(res).toEqual({ status: 'Accepted', transactionId: expect.any(String) });
    expect(h.sent('Authorize')).toHaveLength(0);
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    expect(started).toMatchObject({
      triggerReason: 'RemoteStart',
      idToken: { idToken: 'REMOTE-1', type: 'Central' },
      transactionInfo: { remoteStartId: 77 },
    });
    const profiles = priv(h, 'chargingProfilesCache') as Map<number, Record<string, unknown>>;
    expect(profiles.get(31)).toMatchObject({ _evseId: 1, chargingProfilePurpose: 'TxProfile' });
  });

  it('plugged EVSE whose token the CSMS refuses: Rejected with the error as reason', async () => {
    const h = await liveHarness('ocpp2.1', (action) =>
      action === 'Authorize' ? { idTokenInfo: { status: 'Blocked' } } : undefined,
    );
    await h.sim.plugIn(1);
    const res = await h.invoke('RequestStartTransaction', {
      remoteStartId: 1,
      idToken: { idToken: 'BAD', type: 'ISO14443' },
      evseId: 1,
    });
    expect(res).toEqual({
      status: 'Rejected',
      statusInfo: { reasonCode: 'Authorization rejected: Blocked' },
    });
    expect(h.sent('TransactionEvent').filter((e) => e['eventType'] === 'Started')).toHaveLength(0);
  });

  it('unplugged EVSE: answers first, then authorizes the token', async () => {
    const h = await liveHarness('ocpp2.1');
    const res = await h.invoke('RequestStartTransaction', {
      remoteStartId: 5,
      idToken: { idToken: 'LATER', type: 'ISO14443' },
      evseId: 1,
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(h.sent('Authorize')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('Authorize')[0]).toMatchObject({
      idToken: { idToken: 'LATER', type: 'ISO14443' },
    });
  });

  it('1.6 sim: RequestStopTransaction for an unknown transaction is a bare Rejected', async () => {
    const h = await liveHarness('ocpp1.6');
    expect(await h.invoke('RequestStopTransaction', { transactionId: 'nope' })).toEqual({
      status: 'Rejected',
    });
  });
});

describe('RemoteStartTransaction 1.6', () => {
  it('plugged connector: Accepted, then StartTransaction follows', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    h.sendCall.mockClear();
    const res = await h.invoke('RemoteStartTransaction', { idTag: 'RS-1', connectorId: 1 });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('StartTransaction')[0]).toMatchObject({ connectorId: 1, idTag: 'RS-1' });
  });

  it('plugged connector with a refused idTag: Accepted, the start fails and is logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await liveHarness('ocpp1.6', (action) =>
      action === 'Authorize' ? { idTagInfo: { status: 'Invalid' } } : undefined,
    );
    await h.sim.plugIn(1);
    const res = await h.invoke('RemoteStartTransaction', { idTag: 'RS-BAD', connectorId: 1 });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('StartTransaction')).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('post-Accepted start failed: Authorization rejected: Invalid'),
    );
  });
});

describe('Reset ImmediateAndResume (B13)', () => {
  it('Accepted with a ResumptionTimeout, and the reset runs after the response', async () => {
    const h = await liveHarness('ocpp2.1');
    setVar(h, 'TxCtrlr.ResumptionTimeout', '60');
    const spy = vi
      .spyOn(
        h.p as { resetAndResumeTransactions: (id?: number) => Promise<void> },
        'resetAndResumeTransactions',
      )
      .mockResolvedValue(undefined);
    const res = await h.invoke('Reset', { type: 'ImmediateAndResume', evseId: 1 });
    expect(res).toEqual({ status: 'Accepted' });
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledWith(1);
  });

  it('a failing resume is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await liveHarness('ocpp2.1');
    setVar(h, 'TxCtrlr.ResumptionTimeout', '60');
    vi.spyOn(
      h.p as { resetAndResumeTransactions: (id?: number) => Promise<void> },
      'resetAndResumeTransactions',
    ).mockRejectedValue(new Error('boom'));
    await h.invoke('Reset', { type: 'ImmediateAndResume' });
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ImmediateAndResume reset failed: boom'),
    );
  });
});

describe('UnlockConnector', () => {
  it.each(['Inoperative', 'Unavailable'])('fails while the station is %s', async (state) => {
    const h = await liveHarness('ocpp2.1');
    (h.p as { availabilityState: string }).availabilityState = state;
    expect(await h.invoke('UnlockConnector', { evseId: 1, connectorId: 1 })).toEqual({
      status: 'UnlockFailed',
    });
  });
});

describe('GetVariables (B06)', () => {
  it('reports unknown component, unknown variable, unsupported attribute type and values', async () => {
    const h = await makeHarness();
    setVar(h, 'TestCtrlr.Plain', 'plain');
    setVar(h, 'TestCtrlr.Inst#A', 'instance-a');
    setVar(h, 'TestCtrlr[1].Scoped', 'evse-1');
    setVar(h, 'TestCtrlr[1,1].Scoped', 'conn-1');
    setVar(h, 'TestCtrlr[1].Both#B', 'evse-inst');
    const req = (
      component: Record<string, unknown>,
      variable: Record<string, unknown>,
      attributeType?: string,
    ) => ({
      component,
      variable,
      ...(attributeType != null ? { attributeType } : {}),
    });
    const res = await h.invoke('GetVariables', {
      getVariableData: [
        req({ name: 'NoSuchCtrlr' }, { name: 'X' }),
        req({ name: 'TestCtrlr' }, { name: 'Missing' }),
        req({ name: 'TestCtrlr' }, { name: 'Plain' }, 'Target'),
        req({ name: 'TestCtrlr' }, { name: 'Plain' }),
        req({ name: 'TestCtrlr' }, { name: 'Inst', instance: 'A' }),
        req({ name: 'TestCtrlr', evse: { id: 1 } }, { name: 'Scoped' }),
        req({ name: 'TestCtrlr', evse: { id: 1, connectorId: 1 } }, { name: 'Scoped' }),
        req({ name: 'TestCtrlr', evse: { id: 1 }, instance: 'B' }, { name: 'Both' }),
      ],
    });
    const results = res['getVariableResult'] as Array<Record<string, unknown>>;
    expect(results.map((r) => r['attributeStatus'])).toEqual([
      'UnknownComponent',
      'UnknownVariable',
      'NotSupportedAttributeType',
      'Accepted',
      'Accepted',
      'Accepted',
      'Accepted',
      'Accepted',
    ]);
    expect(results.slice(3).map((r) => r['attributeValue'])).toEqual([
      'plain',
      'instance-a',
      'evse-1',
      'conn-1',
      'evse-inst',
    ]);
    expect(results[2]?.['attributeType']).toBe('Target');
  });
});

describe('SetVariables (B05)', () => {
  function sv(
    component: Record<string, unknown>,
    variable: Record<string, unknown>,
    attributeValue: string,
    attributeType?: string,
  ) {
    return {
      component,
      variable,
      attributeValue,
      ...(attributeType != null ? { attributeType } : {}),
    };
  }

  it('writes instance-scoped keys and rejects unknown variables and attribute types', async () => {
    const h = await makeHarness();
    setVar(h, 'TestCtrlr.Inst#A', 'old');
    setVar(h, 'TestCtrlr[1].Both#B', 'old');
    const res = await h.invoke('SetVariables', {
      setVariableData: [
        sv({ name: 'TestCtrlr' }, { name: 'Inst', instance: 'A' }, 'new-a'),
        sv({ name: 'TestCtrlr', evse: { id: 1 }, instance: 'B' }, { name: 'Both' }, 'new-b'),
        sv({ name: 'TestCtrlr' }, { name: 'Missing' }, 'x'),
        sv({ name: 'TestCtrlr' }, { name: 'Inst', instance: 'A' }, 'y', 'MaxSet'),
      ],
    });
    const statuses = (res['setVariableResult'] as Array<Record<string, unknown>>).map(
      (r) => r['attributeStatus'],
    );
    expect(statuses).toEqual([
      'Accepted',
      'Accepted',
      'UnknownVariable',
      'NotSupportedAttributeType',
    ]);
    expect(config(h).get('TestCtrlr.Inst#A')?.value).toBe('new-a');
    expect(config(h).get('TestCtrlr[1].Both#B')?.value).toBe('new-b');
  });

  it('refuses a NetworkConfiguration security profile downgrade unless allowed', async () => {
    const h = await makeHarness();
    setVar(h, 'SecurityCtrlr.SecurityProfile', '2');
    setVar(h, 'NetworkConfiguration.SecurityProfile', '2');
    setVar(h, 'SecurityCtrlr.AllowSecurityDowngrade', 'false');
    const down = await h.invoke('SetVariables', {
      setVariableData: [sv({ name: 'NetworkConfiguration' }, { name: 'SecurityProfile' }, '1')],
    });
    expect(
      (down['setVariableResult'] as Array<Record<string, unknown>>)[0]?.['attributeStatus'],
    ).toBe('Rejected');
    expect(config(h).get('NetworkConfiguration.SecurityProfile')?.value).toBe('2');

    setVar(h, 'SecurityCtrlr.AllowSecurityDowngrade', 'true');
    const allowed = await h.invoke('SetVariables', {
      setVariableData: [sv({ name: 'NetworkConfiguration' }, { name: 'SecurityProfile' }, '1')],
    });
    expect(
      (allowed['setVariableResult'] as Array<Record<string, unknown>>)[0]?.['attributeStatus'],
    ).toBe('Accepted');
  });

  it('refuses changes to the active network configuration slot', async () => {
    const h = await makeHarness();
    setVar(h, 'OCPPCommCtrlr.NetworkConfigurationPriority', '2,1');
    setVar(h, 'NetworkConfiguration.MessageTimeout#2', '30');
    setVar(h, 'NetworkConfiguration.MessageTimeout#1', '30');
    const res = await h.invoke('SetVariables', {
      setVariableData: [
        sv({ name: 'NetworkConfiguration', instance: '2' }, { name: 'MessageTimeout' }, '60'),
        sv({ name: 'NetworkConfiguration', instance: '1' }, { name: 'MessageTimeout' }, '60'),
      ],
    });
    expect(
      (res['setVariableResult'] as Array<Record<string, unknown>>).map((r) => r['attributeStatus']),
    ).toEqual(['Rejected', 'Accepted']);
    expect(config(h).get('NetworkConfiguration.MessageTimeout#2')?.value).toBe('30');
    expect(config(h).get('NetworkConfiguration.MessageTimeout#1')?.value).toBe('60');
  });

  it('a monitor on the written variable reports the new value after the response (N07)', async () => {
    const h = await makeHarness();
    setVar(h, 'TestCtrlr.Level', '10');
    const mon = await h.invoke('SetVariableMonitoring', {
      setMonitoringData: [
        {
          value: 50,
          type: 'UpperThreshold',
          severity: 5,
          component: { name: 'TestCtrlr' },
          variable: { name: 'Level' },
        },
      ],
    });
    expect((mon['setMonitoringResult'] as Array<Record<string, unknown>>)[0]?.['status']).toBe(
      'Accepted',
    );
    await vi.advanceTimersByTimeAsync(0);
    h.sendCall.mockClear();
    await h.invoke('SetVariables', {
      setVariableData: [sv({ name: 'TestCtrlr' }, { name: 'Level' }, '80')],
    });
    expect(h.sent('NotifyEvent')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    const events = h
      .sent('NotifyEvent')
      .flatMap((e) => e['eventData'] as Array<Record<string, unknown>>);
    expect(events).toContainEqual(
      expect.objectContaining({
        trigger: 'Alerting',
        actualValue: '80',
        component: { name: 'TestCtrlr' },
        variable: { name: 'Level' },
      }),
    );
  });
});

describe('GetConfiguration and ChangeConfiguration (1.6)', () => {
  it('returns every key without a filter and lists unknown keys', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const all = await h.invoke('GetConfiguration', {});
    const keys = all['configurationKey'] as Array<{ key: string; value: string }>;
    expect(keys.length).toBe(config(h).size);
    expect(keys.find((k) => k.key === 'AuthorizationKey')?.value ?? '').toBe('');
    const some = await h.invoke('GetConfiguration', { key: ['HeartbeatInterval', 'Nope'] });
    expect(some['unknownKey']).toEqual(['Nope']);
    expect((some['configurationKey'] as unknown[]).length).toBe(1);
  });

  it('NotSupported for unknown keys, Rejected for read-only keys and invalid integers', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await h.invoke('ChangeConfiguration', { key: 'NoSuchKey', value: '1' })).toEqual({
      status: 'NotSupported',
    });
    setVar(h, 'ReadOnlyKey', 'x', true);
    expect(await h.invoke('ChangeConfiguration', { key: 'ReadOnlyKey', value: 'y' })).toEqual({
      status: 'Rejected',
    });
    for (const bad of ['-1', '1.5', 'abc']) {
      expect(
        await h.invoke('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: bad }),
      ).toEqual({ status: 'Rejected' });
    }
    expect(
      await h.invoke('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '15' }),
    ).toEqual({ status: 'Accepted' });
    expect(config(h).get('MeterValueSampleInterval')?.value).toBe('15');
    expect(
      await h.invoke('ChangeConfiguration', { key: 'ConnectionTimeOut', value: '45' }),
    ).toEqual({
      status: 'RebootRequired',
    });
  });
});

describe('GetReport componentCriteria (B08)', () => {
  it('reports only the variables matching the criteria', async () => {
    const h = await makeHarness();
    setVar(h, 'TestCtrlr.Enabled', 'true');
    setVar(h, 'OffCtrlr.Enabled', 'false');
    setVar(h, 'TestCtrlr.AvailabilityState', 'Available');
    setVar(h, 'TestCtrlr.Tripped', 'false');
    const res = await h.invoke('GetReport', { requestId: 9, componentCriteria: ['Enabled'] });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(300);
    const report = h.sent('NotifyReport').at(-1);
    expect(report?.['requestId']).toBe(9);
    const data = report?.['reportData'] as Array<Record<string, unknown>>;
    expect(data.length).toBeGreaterThan(0);
    for (const d of data) {
      expect(d['variable']).toMatchObject({ name: 'Enabled' });
      expect((d['variableAttribute'] as Array<Record<string, unknown>>)[0]?.['value']).toBe('true');
    }
    expect(
      data.some((d) => (d['component'] as Record<string, unknown>)['name'] === 'OffCtrlr'),
    ).toBe(false);

    h.sendCall.mockClear();
    await h.invoke('GetReport', {
      requestId: 10,
      componentCriteria: ['Available', 'Problem', 'Active'],
    });
    await vi.advanceTimersByTimeAsync(300);
    const names = (h.sent('NotifyReport')[0]?.['reportData'] as Array<Record<string, unknown>>).map(
      (d) => (d['variable'] as Record<string, unknown>)['name'],
    );
    expect(names).toEqual(expect.arrayContaining(['AvailabilityState', 'Tripped', 'Enabled']));
    expect(new Set(names)).toEqual(
      new Set(
        names.filter((n) =>
          ['AvailabilityState', 'Tripped', 'Problem', 'Overload', 'Fallback', 'Enabled'].includes(
            n as string,
          ),
        ),
      ),
    );
  });
});

describe('ReserveNow with in-memory reservations', () => {
  it('2.1 any-EVSE reservation is Occupied when every EVSE is reserved in memory', async () => {
    const h = await liveHarness('ocpp2.1', undefined, TWO_EVSES);
    const reservations = priv(h, 'reservations') as Map<number, Record<string, unknown>>;
    reservations.set(901, {
      id: 901,
      evseId: 0,
      idToken: 'X',
      expiryDateTime: '2099-01-01T00:00:00Z',
    });
    const res = await h.invoke('ReserveNow', {
      id: 902,
      idToken: { idToken: 'Y', type: 'ISO14443' },
      expiryDateTime: '2099-01-01T00:00:00Z',
    });
    expect(res).toEqual({ status: 'Occupied' });
  });

  it('2.1 any-EVSE reservation picks the EVSE without a reservation', async () => {
    const h = await liveHarness('ocpp2.1', undefined, TWO_EVSES);
    const reservations = priv(h, 'reservations') as Map<number, Record<string, unknown>>;
    reservations.set(901, {
      id: 901,
      evseId: 1,
      idToken: 'X',
      expiryDateTime: '2099-01-01T00:00:00Z',
    });
    const res = await h.invoke('ReserveNow', {
      id: 903,
      idToken: { idToken: 'Y', type: 'ISO14443' },
      expiryDateTime: '2099-01-01T00:00:00Z',
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(reservations.get(903)).toMatchObject({ evseId: 2 });
  });
});

describe('certificate and firmware requests not handled by 2.1', () => {
  it('2.1: unknown certificate delete is NotFound, an EXPIRED certificate is refused', async () => {
    const h = await makeHarness();
    expect(
      await h.invoke('DeleteCertificate', {
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'a',
          issuerKeyHash: 'b',
          serialNumber: 'none',
        },
      }),
    ).toEqual({ status: 'NotFound' });
    const before = (priv(h, 'installedCertificatesCache') as Map<string, unknown>).size;
    expect(
      await h.invoke('InstallCertificate', {
        certificateType: 'CSMSRootCertificate',
        certificate: '-----BEGIN CERTIFICATE-----EXPIRED-----END CERTIFICATE-----',
      }),
    ).toEqual({ status: 'Rejected' });
    expect((priv(h, 'installedCertificatesCache') as Map<string, unknown>).size).toBe(before);
  });

  it('2.1: ExtendedTriggerMessage and SignedUpdateFirmware are 1.6 messages', async () => {
    const h = await makeHarness();
    expect(await h.invoke('ExtendedTriggerMessage', { requestedMessage: 'Heartbeat' })).toEqual({
      status: 'NotSupported',
    });
    expect(await h.invoke('SignedUpdateFirmware', { requestId: 1 })).toEqual({
      status: 'NotSupported',
    });
  });

  it('1.6: GetDiagnostics answers with the file name', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    vi.spyOn(
      h.p as { simulateDiagnosticsUpload: (l: string) => Promise<void> },
      'simulateDiagnosticsUpload',
    ).mockResolvedValue(undefined);
    expect(await h.invoke('GetDiagnostics', { location: 'ftp://diag' })).toEqual({
      fileName: 'diagnostics.txt',
    });
    expect(
      (h.p as { simulateDiagnosticsUpload: (l: string) => Promise<void> })
        .simulateDiagnosticsUpload,
    ).toHaveBeenCalledWith('ftp://diag');
  });
});

describe('SendLocalList Differential (D02)', () => {
  it.each([
    [
      'ocpp2.1',
      (id: string, status?: string) => ({
        idToken: { idToken: id, type: 'ISO14443' },
        ...(status != null ? { idTokenInfo: { status } } : {}),
      }),
    ],
    [
      'ocpp1.6',
      (id: string, status?: string) => ({
        idTag: id,
        ...(status != null ? { idTagInfo: { status } } : {}),
      }),
    ],
  ] as const)(
    '%s: adds entries with a status and removes entries without one',
    async (protocol, entry) => {
      const h = await makeHarness({ protocol });
      if (protocol === 'ocpp1.6') {
        setVar(h, 'SupportedFeatureProfiles', 'Core,LocalAuthListManagement');
        setVar(h, 'LocalAuthListEnabled', 'true');
      }
      const full = await h.invoke('SendLocalList', {
        updateType: 'Full',
        versionNumber: 1,
        listVersion: 1,
        localAuthorizationList: [entry('A', 'Accepted'), entry('B', 'Accepted')],
      });
      expect(full).toEqual({ status: 'Accepted' });
      const diff = await h.invoke('SendLocalList', {
        updateType: 'Differential',
        versionNumber: 2,
        listVersion: 2,
        localAuthorizationList: [entry('B'), entry('C', 'Blocked'), { other: true }],
      });
      expect(diff).toEqual({ status: 'Accepted' });
      const local = priv(h, 'localAuthEntries') as Map<string, unknown>;
      expect([...local.keys()].sort()).toEqual(['A', 'C']);
      expect(priv(h, 'localAuthListVersion')).toBe(2);
    },
  );
});

describe('SetNetworkProfile (B09)', () => {
  it.each([0, 11, undefined])('rejects configuration slot %s', async (slot) => {
    const h = await makeHarness();
    expect(
      await h.invoke('SetNetworkProfile', {
        ...(slot != null ? { configurationSlot: slot } : {}),
        connectionData: { ocppCsmsUrl: 'ws://x', securityProfile: 1 },
      }),
    ).toEqual({ status: 'Rejected' });
  });

  it('rejects a lower security profile unless downgrades are allowed', async () => {
    const h = await makeHarness();
    setVar(h, 'SecurityCtrlr.SecurityProfile', '2');
    setVar(h, 'SecurityCtrlr.AllowSecurityDowngrade', 'false');
    expect(
      await h.invoke('SetNetworkProfile', {
        configurationSlot: 2,
        connectionData: { ocppCsmsUrl: 'ws://x', securityProfile: 1 },
      }),
    ).toEqual({ status: 'Rejected' });
    expect(config(h).get('NetworkConfiguration.OcppCsmsUrl#2')?.value).not.toBe('ws://x');
  });
});

describe('SetDisplayMessage with a transaction', () => {
  it('accepts a transaction-bound message while a transaction runs', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG');
    const res = await h.invoke('SetDisplayMessage', {
      message: {
        id: 12,
        priority: 'NormalCycle',
        transactionId: txId,
        message: { format: 'UTF8', content: 'Hello' },
      },
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect((priv(h, 'displayMessagesCache') as Map<number, unknown>).has(12)).toBe(true);
  });
});

describe('tariffs (I07/I08)', () => {
  it('GetTariffs lists driver tariffs per EVSE and station-wide', async () => {
    const h = await makeHarness({ config: { evses: TWO_EVSES } });
    const driverTariffs = priv(h, 'driverTariffs') as Map<
      number,
      { tariffId: string; tariff: unknown }
    >;
    driverTariffs.set(0, { tariffId: 'DRV-ALL', tariff: {} });
    driverTariffs.set(2, { tariffId: 'DRV-2', tariff: {} });
    const all = await h.invoke('GetTariffs', {});
    expect(all).toEqual({
      status: 'Accepted',
      tariffAssignments: [
        { tariffId: 'DRV-2', tariffKind: 'DriverTariff', evseIds: [2] },
        { tariffId: 'DRV-ALL', tariffKind: 'DriverTariff', evseIds: [1, 2] },
      ],
    });
    const evse1 = await h.invoke('GetTariffs', { evseId: 1 });
    expect(evse1['tariffAssignments']).toEqual([
      { tariffId: 'DRV-ALL', tariffKind: 'DriverTariff', evseIds: [1, 2] },
    ]);
  });

  it('ClearTariffs keeps a tariff in use but reports it cleared', async () => {
    const h = await makeHarness();
    const set = await h.invoke('SetDefaultTariff', {
      evseId: 1,
      tariff: { tariffId: 'T-1', currency: 'EUR', energy: { prices: [{ priceKwh: 0.3 }] } },
    });
    expect(set['status']).toBe('Accepted');
    const defaults = priv(h, 'defaultTariffs') as Map<string, { inUse: boolean }>;
    const entry = defaults.get('T-1');
    expect(entry).toBeDefined();
    if (entry != null) entry.inUse = true;
    expect(await h.invoke('ClearTariffs', { tariffIds: ['T-1'] })).toEqual({
      clearTariffsResult: [{ tariffId: 'T-1', status: 'Accepted' }],
    });
    expect(defaults.has('T-1')).toBe(true);
  });
});

describe('station-initiated messages', () => {
  it.each([
    [
      'sendDataTransfer',
      ['V', 'M', 'D'],
      'DataTransfer',
      { vendorId: 'V', messageId: 'M', data: 'D' },
    ],
    ['sendDataTransfer', ['V'], 'DataTransfer', { vendorId: 'V' }],
    [
      'sendNotifyChargingLimit',
      [{ chargingLimitSource: 'EMS' }, [{ id: 1 }]],
      'NotifyChargingLimit',
      { chargingLimit: { chargingLimitSource: 'EMS' }, chargingSchedule: [{ id: 1 }] },
    ],
    [
      'sendNotifyChargingLimit',
      [{ chargingLimitSource: 'EMS' }],
      'NotifyChargingLimit',
      { chargingLimit: { chargingLimitSource: 'EMS' } },
    ],
    [
      'sendNotifyEVChargingNeeds',
      [1, { requestedEnergyTransfer: 'AC_three_phase' }],
      'NotifyEVChargingNeeds',
      { evseId: 1, chargingNeeds: { requestedEnergyTransfer: 'AC_three_phase' } },
    ],
    [
      'sendClearedChargingLimit',
      ['EMS', 2],
      'ClearedChargingLimit',
      { chargingLimitSource: 'EMS', evseId: 2 },
    ],
    ['sendClearedChargingLimit', ['EMS'], 'ClearedChargingLimit', { chargingLimitSource: 'EMS' }],
    [
      'sendSignCertificate',
      ['CSR'],
      'SignCertificate',
      { csr: 'CSR', certificateType: 'ChargingStationCertificate' },
    ],
    [
      'sendGetCertificateStatus',
      [{ serialNumber: 'S' }],
      'GetCertificateStatus',
      { ocspRequestData: { serialNumber: 'S' } },
    ],
    ['sendGetTransactionStatus', ['TX'], 'GetTransactionStatus', { transactionId: 'TX' }],
    ['sendGetTransactionStatus', [], 'GetTransactionStatus', {}],
    [
      'sendReportChargingProfiles',
      [3, [{ id: 1 }], 1],
      'ReportChargingProfiles',
      {
        requestId: 3,
        chargingLimitSource: 'CSO',
        chargingProfile: [{ id: 1 }],
        evseId: 1,
        tbc: false,
      },
    ],
    [
      'sendNotifyEVChargingSchedule',
      ['2026-01-01T00:00:00Z', 1, { id: 1 }],
      'NotifyEVChargingSchedule',
      { timeBase: '2026-01-01T00:00:00Z', evseId: 1, chargingSchedule: { id: 1 } },
    ],
    ['sendNotifySettlement', [{ pspRef: 'P' }], 'NotifySettlement', { pspRef: 'P' }],
    [
      'sendNotifyPriorityCharging',
      ['TX', true],
      'NotifyPriorityCharging',
      { transactionId: 'TX', activated: true },
    ],
    [
      'sendNotifyAllowedEnergyTransfer',
      [['DC']],
      'NotifyAllowedEnergyTransfer',
      { transactionId: 'unknown', allowedEnergyTransfer: ['DC'] },
    ],
    [
      'sendGet15118EVCertificate',
      ['urn:iso', 'Install', 'EXI'],
      'Get15118EVCertificate',
      { iso15118SchemaVersion: 'urn:iso', action: 'Install', exiRequest: 'EXI' },
    ],
    [
      'sendGetCertificateChainStatus',
      [{ certificateStatusRequests: [] }],
      'GetCertificateChainStatus',
      { certificateStatusRequests: [] },
    ],
    ['sendNotifyPeriodicEventStream', [{ id: 1 }], 'NotifyPeriodicEventStream', { id: 1 }],
    [
      'sendNotifyDERAlarm',
      [{ controlType: 'FreqDroop' }],
      'NotifyDERAlarm',
      { controlType: 'FreqDroop' },
    ],
    ['sendNotifyDERStartStop', [{ controlId: 'C' }], 'NotifyDERStartStop', { controlId: 'C' }],
    ['sendReportDERControl', [{ requestId: 1 }], 'ReportDERControl', { requestId: 1 }],
    ['sendBatterySwap', [{ eventType: 'BatteryIn' }], 'BatterySwap', { eventType: 'BatteryIn' }],
    ['sendPullDynamicScheduleUpdate', [4], 'PullDynamicScheduleUpdate', { chargingProfileId: 4 }],
    ['sendVatNumberValidation', ['NL1', 1], 'VatNumberValidation', { vatNumber: 'NL1', evseId: 1 }],
    ['sendVatNumberValidation', ['NL1'], 'VatNumberValidation', { vatNumber: 'NL1' }],
  ] as const)('%s sends %s', async (method, args, action, payload) => {
    const h = await makeHarness();
    const fn = (h.sim as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
    if (fn == null) throw new Error(`no method ${method}`);
    await fn.apply(h.sim, [...args]);
    expect(h.sendCall).toHaveBeenLastCalledWith(action, payload);
  });

  it('1.6 sendStopTransaction includes the idTag only when given', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.sim.sendStopTransaction(5, 1200, 'EVDisconnected', 'TAG');
    expect(h.sent('StopTransaction')[0]).toMatchObject({
      transactionId: 5,
      meterStop: 1200,
      reason: 'EVDisconnected',
      idTag: 'TAG',
    });
    await h.sim.sendStopTransaction(6, 1300);
    expect(h.sent('StopTransaction')[1]).not.toHaveProperty('idTag');
    expect(h.sent('StopTransaction')[1]).toMatchObject({ reason: 'Local' });
  });
});

describe('WebPaymentsCtrlr values (C25)', () => {
  it('Enabled must be a boolean, unknown variables pass', async () => {
    const h = await makeHarness();
    setVar(h, 'WebPaymentsCtrlr.Enabled', 'false');
    setVar(h, 'WebPaymentsCtrlr.Custom', 'x');
    const res = await h.invoke('SetVariables', {
      setVariableData: [
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'Enabled' },
          attributeValue: 'yes',
        },
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'Enabled' },
          attributeValue: 'true',
        },
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'Custom' },
          attributeValue: 'y',
        },
      ],
    });
    expect(
      (res['setVariableResult'] as Array<Record<string, unknown>>).map((r) => r['attributeStatus']),
    ).toEqual(['Rejected', 'Accepted', 'Accepted']);
  });

  it('no QR code URL when the configuration is incomplete', async () => {
    const h = await makeHarness();
    setVar(h, 'WebPaymentsCtrlr.Enabled', 'true');
    setVar(h, 'WebPaymentsCtrlr.URLTemplate', 'https://pay/{totp}');
    setVar(h, 'WebPaymentsCtrlr.TOTPVersion', 'v9');
    expect(h.sim.webPaymentQrUrl(1)).toBeNull();
  });
});

describe('stop()', () => {
  it('clears every running timer and marks the station disconnected', async () => {
    const queries: unknown[][] = [];
    const h = await makeHarness({
      sql: stubSql((_q, values) => {
        queries.push(values);
        return undefined;
      }),
    });
    const noop = (): void => {};
    (priv(h, 'txEndedTimers') as Map<number, unknown>).set(1, [setTimeout(noop, 1000)]);
    (priv(h, 'periodicMonitorTimers') as Map<number, unknown>).set(3, setInterval(noop, 1000));
    (priv(h, 'certSigningTimers') as Map<string, unknown>).set(
      'ChargingStationCertificate',
      setTimeout(noop, 1000),
    );
    (h.p as { certificateReconnectTimer: unknown }).certificateReconnectTimer = setTimeout(
      noop,
      1000,
    );
    (priv(h, 'connectionTimeoutTimers') as Map<number, unknown>).set(1, setTimeout(noop, 1000));
    (priv(h, 'evConnectTimeoutTimers') as Map<number, unknown>).set(1, setTimeout(noop, 1000));
    (priv(h, 'reservationTimers') as Map<number, unknown>).set(8, setTimeout(noop, 1000));
    (priv(h, 'reservations') as Map<number, unknown>).set(8, { id: 8, evseId: 1 });

    await h.sim.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect((priv(h, 'txEndedTimers') as Map<number, unknown>).size).toBe(0);
    expect((priv(h, 'certSigningTimers') as Map<string, unknown>).size).toBe(0);
    expect(priv(h, 'certificateReconnectTimer')).toBeNull();
    expect((priv(h, 'reservations') as Map<number, unknown>).size).toBe(0);
    expect(h.sim.client.disconnect).toHaveBeenCalled();
    expect(queries.some((v) => v.includes('disconnected'))).toBe(true);
  });
});
