// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import type postgres from 'postgres';
import * as x509 from '@peculiar/x509';
import { StationSimulator, type StationConfig } from '../station-simulator.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const EC = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

/** A self-signed CA certificate valid from yesterday for a year, as PEM. */
async function selfSignedCaPem(name: string): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    keys,
    signingAlgorithm: EC,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return cert.toString('pem');
}

let csmsRootPem = '';
beforeAll(async () => {
  csmsRootPem = await selfSignedCaPem('CN=Test CSMS Root');
});

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

function makeSimulator(
  ocppProtocol: 'ocpp1.6' | 'ocpp2.1',
  securityProfile = 0,
  extra: Partial<StationConfig> = {},
): StationSimulator {
  const config: StationConfig = {
    id: 'css_sec',
    stationId: 'SEC-001',
    ocppProtocol,
    securityProfile,
    targetUrl: 'ws://ocpp:7103',
    password: 'old-password-1234',
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
    ...extra,
  };
  const sim = new StationSimulator(config, noopSql());
  // Default device model, as start() seeds it on a fresh station.
  (sim as unknown as { seedDefaultConfigVariables: () => void }).seedDefaultConfigVariables();
  Object.defineProperty(sim.client, 'sendCall', {
    value: vi.fn(async () => ({ status: 'Accepted' })),
    writable: true,
  });
  return sim;
}

interface SimInternals {
  handleCsmsCommand: (
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  rebootConnections: () =>
    | { serverUrl: string; password: string; securityProfile: number }[]
    | null;
  chooseRebootConnection: (attempt: number) => void;
  commitConnection: (c: {
    serverUrl: string;
    password: string;
    securityProfile: number;
  }) => Promise<void>;
  getConfigValue: (key: string) => string | undefined;
  rebootCandidates: unknown;
}

const internals = (sim: StationSimulator): SimInternals => sim as unknown as SimInternals;
const call = (sim: StationSimulator, action: string, payload: Record<string, unknown>) =>
  internals(sim).handleCsmsCommand.call(sim, 'm1', action, payload);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OCPP 1.6 AuthorizationKey (OCTT TC_073)', () => {
  it('accepts a hex key of 16-20 bytes and uses the decoded password', async () => {
    const sim = makeSimulator('ocpp1.6', 1);

    const res = await call(sim, 'ChangeConfiguration', {
      key: 'AuthorizationKey',
      value: '4F43415F4F4354545F61646D696E5F74657374',
    });

    expect(res).toEqual({ status: 'Accepted' });
    expect(sim.client.connection.password).toBe('OCA_OCTT_admin_test');
  });

  it('rejects a key that is not hex or not 16-20 bytes', async () => {
    const sim = makeSimulator('ocpp1.6', 1);
    for (const value of ['not-hex-at-all-xx', '41'.repeat(15), '41'.repeat(21)]) {
      expect(await call(sim, 'ChangeConfiguration', { key: 'AuthorizationKey', value })).toEqual({
        status: 'Rejected',
      });
    }
    expect(sim.client.connection.password).toBe('old-password-1234');
  });

  it('never reports the key in GetConfiguration (write-only)', async () => {
    const sim = makeSimulator('ocpp1.6', 1);
    await call(sim, 'ChangeConfiguration', {
      key: 'AuthorizationKey',
      value: '4F43415F4F4354545F61646D696E5F74657374',
    });

    const res = (await call(sim, 'GetConfiguration', { key: ['AuthorizationKey'] })) as {
      configurationKey: { key: string; value: string }[];
    };
    expect(res.configurationKey[0]).toMatchObject({ key: 'AuthorizationKey', value: '' });
  });
});

describe('OCPP 1.6 SecurityProfile upgrade', () => {
  it('accepts only an upgrade and applies it on the next reboot', async () => {
    const sim = makeSimulator('ocpp1.6', 1);
    expect(await call(sim, 'ChangeConfiguration', { key: 'SecurityProfile', value: '1' })).toEqual({
      status: 'Rejected',
    });
    expect(await call(sim, 'ChangeConfiguration', { key: 'SecurityProfile', value: '2' })).toEqual({
      status: 'Accepted',
    });

    const candidates = internals(sim).rebootConnections.call(sim);
    expect(candidates?.[0]).toMatchObject({ securityProfile: 2 });
    expect(candidates?.[0]?.serverUrl).toMatch(/^wss:\/\//);
    // Falls back to the old connection if the new one fails.
    expect(candidates?.[1]).toMatchObject({ securityProfile: 1, serverUrl: 'ws://ocpp:7103' });
  });

  it('records the new profile once connected', async () => {
    const sim = makeSimulator('ocpp1.6', 0);
    await call(sim, 'ChangeConfiguration', { key: 'SecurityProfile', value: '1' });
    const [candidate] = internals(sim).rebootConnections.call(sim) ?? [];
    if (candidate == null) throw new Error('no candidate');

    await internals(sim).commitConnection.call(sim, candidate);

    expect(internals(sim).getConfigValue.call(sim, 'SecurityProfile')).toBe('1');
    expect(internals(sim).rebootConnections.call(sim)).toBeNull();
  });
});

describe('OCPP 2.1 password and security profile (A01, A05)', () => {
  it('rejects SetVariables on SecurityCtrlr.SecurityProfile (ReadOnly)', async () => {
    const sim = makeSimulator('ocpp2.1', 1);
    const res = (await call(sim, 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'SecurityProfile' },
          attributeValue: '2',
        },
      ],
    })) as { setVariableResult: { attributeStatus: string }[] };
    expect(res.setVariableResult[0]?.attributeStatus).toBe('Rejected');
  });

  it('uses a new BasicAuthPassword from the next connection', async () => {
    const sim = makeSimulator('ocpp2.1', 1);
    await call(sim, 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: 'new-password-123456',
        },
      ],
    });
    expect(sim.client.connection.password).toBe('new-password-123456');
  });

  it('connects with the first NetworkConfigurationPriority slot after a reboot, then falls back', async () => {
    const sim = makeSimulator('ocpp2.1', 1, { caCert: csmsRootPem });
    expect(
      await call(sim, 'SetNetworkProfile', {
        configurationSlot: 2,
        connectionData: {
          ocppInterface: 'Wired0',
          ocppTransport: 'JSON',
          messageTimeout: 30,
          ocppCsmsUrl: 'wss://ocpp:8443',
          securityProfile: 2,
          basicAuthPassword: 'slot-two-password-1',
        },
      }),
    ).toEqual({ status: 'Accepted' });
    await call(sim, 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
          attributeValue: '2,1',
        },
      ],
    });

    const candidates = internals(sim).rebootConnections.call(sim);
    expect(candidates?.[0]).toEqual({
      serverUrl: 'wss://ocpp:8443',
      securityProfile: 2,
      password: 'slot-two-password-1',
    });
    internals(sim).rebootCandidates = candidates;

    internals(sim).chooseRebootConnection.call(sim, 1);
    expect(sim.client.connection.serverUrl).toBe('wss://ocpp:8443');
    // After three failed attempts on slot 2, slot 1 (the old profile) is tried.
    internals(sim).chooseRebootConnection.call(sim, 4);
    expect(sim.client.connection.securityProfile).toBe(1);
  });

  it('makes the new profile permanent and drops lower slots once connected (A05.FR.06)', async () => {
    const sim = makeSimulator('ocpp2.1', 1, { caCert: csmsRootPem });
    await call(sim, 'SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        ocppInterface: 'Wired0',
        ocppTransport: 'JSON',
        messageTimeout: 30,
        ocppCsmsUrl: 'wss://ocpp:8443',
        securityProfile: 2,
      },
    });
    await call(sim, 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
          attributeValue: '2,1',
        },
      ],
    });

    await internals(sim).commitConnection.call(sim, {
      serverUrl: 'wss://ocpp:8443',
      securityProfile: 2,
      password: 'old-password-1234',
    });

    const get = (k: string) => internals(sim).getConfigValue.call(sim, k);
    expect(get('SecurityCtrlr.SecurityProfile')).toBe('2');
    expect(get('OCPPCommCtrlr.NetworkConfigurationPriority')).toBe('2');
  });
});

describe('OCPP 2.1 security checks (A00.FR.205, A05.FR.02/03)', () => {
  const setPassword = async (sim: StationSimulator, value: string) =>
    (
      (await call(sim, 'SetVariables', {
        setVariableData: [
          {
            component: { name: 'SecurityCtrlr' },
            variable: { name: 'BasicAuthPassword' },
            attributeValue: value,
          },
        ],
      })) as { setVariableResult: { attributeStatus: string }[] }
    ).setVariableResult[0]?.attributeStatus;

  it('rejects a BasicAuthPassword outside the passwordString charset or length', async () => {
    const sim = makeSimulator('ocpp2.1', 1);
    expect(await setPassword(sim, 'NewTestPassword1234!')).toBe('Rejected');
    expect(await setPassword(sim, 'short-pass')).toBe('Rejected');
    expect(await setPassword(sim, 'a'.repeat(41))).toBe('Rejected');
    expect(sim.client.connection.password).toBe('old-password-1234');
    expect(await setPassword(sim, 'NewTestPassword1234.')).toBe('Accepted');
  });

  const upgradeTo = async (sim: StationSimulator, securityProfile: number) => {
    await call(sim, 'SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        ocppInterface: 'Wired0',
        ocppVersion: 'OCPP20',
        messageTimeout: 30,
        ocppCsmsUrl: 'wss://ocpp:8443',
        securityProfile,
      },
    });
    const res = (await call(sim, 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
          attributeValue: '2,1',
        },
      ],
    })) as { setVariableResult: { attributeStatus: string }[] };
    return res.setVariableResult[0]?.attributeStatus;
  };

  it('rejects a TLS profile without a valid CSMS root certificate', async () => {
    expect(await upgradeTo(makeSimulator('ocpp2.1', 1), 2)).toBe('Rejected');
    expect(await upgradeTo(makeSimulator('ocpp2.1', 1, { caCert: csmsRootPem }), 2)).toBe(
      'Accepted',
    );
  });

  it('rejects profile 3 without a valid Charging Station certificate', async () => {
    expect(await upgradeTo(makeSimulator('ocpp2.1', 2, { caCert: csmsRootPem }), 3)).toBe(
      'Rejected',
    );
  });

  it('adds an installed CSMS root certificate to the TLS trust store', async () => {
    const sim = makeSimulator('ocpp2.1', 1);
    expect(
      await call(sim, 'InstallCertificate', {
        certificateType: 'CSMSRootCertificate',
        certificate: csmsRootPem,
      }),
    ).toEqual({ status: 'Accepted' });
    expect(await upgradeTo(sim, 2)).toBe('Accepted');
  });
});

describe('Reconnect after a connection loss (OCPP 1.6 4.2, OCPP 2.1 B01/B04)', () => {
  interface ReconnectInternals {
    onReconnect: () => Promise<void>;
    bootStatus: string | null;
    initialBootDone: boolean;
    rebootOnReconnect: boolean;
  }

  const actionsAfterReconnect = async (
    ocppProtocol: 'ocpp1.6' | 'ocpp2.1',
    reboot: boolean,
  ): Promise<string[]> => {
    const sim = makeSimulator(ocppProtocol, 0);
    const state = sim as unknown as ReconnectInternals;
    state.bootStatus = 'Accepted';
    state.initialBootDone = true;
    state.rebootOnReconnect = reboot;
    const sendCall = vi.fn(async () => ({ status: 'Accepted', interval: 300 }));
    Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
    Object.defineProperty(sim.client, 'isConnected', { get: () => true });
    await state.onReconnect.call(sim);
    await sim.stop();
    return sendCall.mock.calls.map((c) => (c as unknown[])[0] as string);
  };

  for (const protocol of ['ocpp1.6', 'ocpp2.1'] as const) {
    it(`${protocol}: no BootNotification after a plain connection loss`, async () => {
      expect(await actionsAfterReconnect(protocol, false)).not.toContain('BootNotification');
    });

    it(`${protocol}: BootNotification after a reboot`, async () => {
      expect(await actionsAfterReconnect(protocol, true)).toContain('BootNotification');
    });
  }
});
