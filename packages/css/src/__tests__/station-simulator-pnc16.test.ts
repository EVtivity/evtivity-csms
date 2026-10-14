// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ISO 15118 Plug and Charge on a 1.6 simulator station, over DataTransfer per the
// OCA application note "Using ISO 15118 Plug & Charge with OCPP 1.6".

import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as x509 from '@peculiar/x509';
import { call, liveHarness, makeHarness, silenceConsole, type Harness } from './sim-harness.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const VENDOR = 'org.openchargealliance.iso15118pnc';
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

const contract = {
  emaid: 'NLEVSC12345678',
  certificate: Buffer.from('leaf'),
  subCertificates: [],
  privateKey: {} as never,
};
const hashData = [
  {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'aa',
    issuerKeyHash: 'bb',
    serialNumber: '1F',
    responderURL: '',
  },
];
const checks = vi.hoisted(() => ({ iso2: vi.fn() }));

vi.mock('../lib/iso15118-test-ev.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/iso15118-test-ev.js')>();
  return {
    ...actual,
    checkIso2Response: checks.iso2,
    contractCertificateHashData: vi.fn(() => hashData),
  };
});

/** A DataTransfer the station sent with the application note's vendorId, unwrapped. */
function wrapped(h: Harness, messageId: string): Array<Record<string, unknown>> {
  return h
    .sent('DataTransfer')
    .filter((d) => d['vendorId'] === VENDOR && d['messageId'] === messageId)
    .map((d) => JSON.parse(String(d['data'])) as Record<string, unknown>);
}

function accepted(message: Record<string, unknown>): Record<string, unknown> {
  return { status: 'Accepted', data: JSON.stringify(message) };
}

async function rootCa(): Promise<{ pem: string; cert: x509.X509Certificate; keys: CryptoKeyPair }> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '0a01',
    name: 'CN=V2G Root 16',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });
  return { pem: cert.toString('pem'), cert, keys };
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
  checks.iso2.mockReturnValue({ ok: true, contract, remaining: null });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('1.6 Plug and Charge EV over DataTransfer', () => {
  it('installs a contract, authorizes with it and starts with the eMAID as idTag', async () => {
    const h = await liveHarness('ocpp1.6', (action, payload) => {
      if (action !== 'DataTransfer') return undefined;
      if (payload['messageId'] === 'Get15118EVCertificate') {
        return accepted({ status: 'Accepted', exiResponse: 'EXI' });
      }
      if (payload['messageId'] === 'Authorize') {
        return accepted({ idTokenInfo: { status: 'Accepted' }, certificateStatus: 'Accepted' });
      }
      return undefined;
    });
    await expect(h.sim.createPncEv(1, 20)).rejects.toThrow(/ISO 15118-2/);
    await h.sim.createPncEv(1);
    expect(await h.sim.installPncContract(1)).toEqual({
      emaid: contract.emaid,
      remainingContracts: null,
    });
    expect(wrapped(h, 'Get15118EVCertificate')[0]).toMatchObject({
      action: 'Install',
      iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef',
    });
    expect(h.sent('Get15118EVCertificate')).toHaveLength(0);

    await h.sim.plugIn(1);
    await h.sim.startPncCharging(1);
    // The wrapped Authorize replaces the regular one (note 5); no IdTokenType type.
    expect(wrapped(h, 'Authorize').at(-1)).toEqual({
      idToken: { idToken: contract.emaid },
      iso15118CertificateHashData: hashData,
    });
    expect(h.sent('Authorize')).toHaveLength(0);
    expect(h.sent('StartTransaction').at(-1)).toMatchObject({ idTag: contract.emaid });
  });

  it('returns the CSMS verdict of authorizePnc and refuses a start it rejects', async () => {
    const h = await liveHarness('ocpp1.6', (action, payload) => {
      if (action !== 'DataTransfer') return undefined;
      if (payload['messageId'] === 'Get15118EVCertificate') {
        return accepted({ status: 'Accepted', exiResponse: 'EXI' });
      }
      return accepted({
        idTokenInfo: { status: 'Invalid' },
        certificateStatus: 'CertificateRevoked',
      });
    });
    await h.sim.createPncEv(1);
    await h.sim.installPncContract(1);
    expect(await h.sim.authorizePnc(1)).toEqual({
      emaid: contract.emaid,
      status: 'Invalid',
      certificateStatus: 'CertificateRevoked',
    });
    await h.sim.plugIn(1);
    await expect(h.sim.startPncCharging(1)).rejects.toThrow(/Invalid/);
    expect(h.sent('StartTransaction')).toHaveLength(0);
  });

  it('is off when ISO15118PnCEnabled is false', async () => {
    const h = await liveHarness('ocpp1.6');
    h.sim.setConfigValue('ISO15118PnCEnabled', 'false');
    await expect(h.sim.createPncEv(1)).rejects.toThrow(/ISO15118PnCEnabled/);
  });
});

describe('1.6 Central System ISO 15118 DataTransfer', () => {
  const dt = (messageId: string, message: Record<string, unknown> | string) => ({
    vendorId: VENDOR,
    messageId,
    data: typeof message === 'string' ? message : JSON.stringify(message),
  });

  it('installs a V2G root, signs its V2G certificate on trigger and accepts the chain', async () => {
    const h = await makeHarness({
      protocol: 'ocpp1.6',
      respond: (action) =>
        action === 'DataTransfer'
          ? { status: 'Accepted', data: '{"status":"Accepted"}' }
          : undefined,
    });
    const root = await rootCa();
    expect(
      await h.invoke(
        'DataTransfer',
        dt('InstallCertificate', {
          certificateType: 'V2GRootCertificate',
          certificate: root.pem,
        }),
      ),
    ).toEqual({ status: 'Accepted', data: '{"status":"Accepted"}' });
    const list = await h.invoke(
      'DataTransfer',
      dt('GetInstalledCertificateIds', {
        certificateType: ['V2GRootCertificate'],
      }),
    );
    expect(JSON.parse(String(list['data']))).toMatchObject({ status: 'Accepted' });

    expect(await h.invoke('DataTransfer', dt('TriggerMessage', {}))).toEqual({
      status: 'Accepted',
      data: '{"status":"Accepted"}',
    });
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => {
      expect(wrapped(h, 'SignCertificate')).toHaveLength(1);
    });
    const sign = wrapped(h, 'SignCertificate')[0];
    expect(Object.keys(sign ?? {})).toEqual(['csr']);
    const csr = new x509.Pkcs10CertificateRequest(String(sign?.['csr']));
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: '0b02',
      subject: csr.subject,
      issuer: root.cert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
      publicKey: await csr.publicKey.export(ALG, ['verify']),
      signingKey: root.keys.privateKey,
      signingAlgorithm: ALG,
    });
    expect(
      await h.invoke(
        'DataTransfer',
        dt('CertificateSigned', { certificateChain: leaf.toString('pem') }),
      ),
    ).toEqual({ status: 'Accepted', data: '{"status":"Accepted"}' });
  });

  it('rejects a chain that is not from an installed V2G root', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const res = await h.invoke(
      'DataTransfer',
      dt('CertificateSigned', { certificateChain: 'garbage' }),
    );
    expect(JSON.parse(String(res['data']))).toEqual({ status: 'Rejected' });
    expect(h.sent('SecurityEventNotification').at(-1)).toMatchObject({
      type: 'InvalidChargePointCertificate',
    });
  });

  it('answers UnknownMessageId, Rejected and UnknownVendorId as the note and OCPP say', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await h.invoke('DataTransfer', dt('Heartbeat', {}))).toEqual({
      status: 'UnknownMessageId',
    });
    expect(await h.invoke('DataTransfer', dt('InstallCertificate', 'not json'))).toEqual({
      status: 'Rejected',
    });
    expect(await h.invoke('DataTransfer', { vendorId: 'com.example', messageId: 'X' })).toEqual({
      status: 'UnknownVendorId',
    });
    h.sim.setConfigValue('ISO15118PnCEnabled', 'false');
    expect(await h.invoke('DataTransfer', dt('TriggerMessage', {}))).toEqual({
      status: 'Rejected',
    });
    await call(h, 'clearCertSigningTimer', 'V2GCertificate');
  });
});
