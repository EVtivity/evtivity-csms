// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as x509 from '@peculiar/x509';
import { call, makeHarness, priv, silenceConsole, stubSql, type Harness } from './sim-harness.js';
import { certificateHashData } from '../lib/station-pki.js';
import { FIRMWARE_IMAGE_FORMAT } from '../lib/manufacturer-root.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 24 * 60 * 60 * 1000;

interface Issued {
  pem: string;
  cert: x509.X509Certificate;
  keys: CryptoKeyPair;
}

function serial(): string {
  return crypto
    .randomBytes(8)
    .toString('hex')
    .replace(/^[89a-f]/, '1');
}

async function newKeys(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function rootCa(name: string): Promise<Issued> {
  const keys = await newKeys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });
  return { pem: cert.toString('pem'), cert, keys };
}

// A leaf issued by `issuer`, for its own new key pair or a given public key (from a CSR).
async function leaf(issuer: Issued, name: string, publicKey?: CryptoKey): Promise<Issued> {
  const keys = await newKeys();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: name,
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    signingKey: issuer.keys.privateKey,
    publicKey: publicKey ?? keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    ],
  });
  return { pem: cert.toString('pem'), cert, keys };
}

async function nodePrivateKey(keys: CryptoKeyPair): Promise<crypto.KeyObject> {
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return crypto.createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });
}

function firmwareImage(version: string): Buffer {
  return Buffer.from(JSON.stringify({ format: FIRMWARE_IMAGE_FORMAT, version }));
}

async function sign(data: Buffer, signer: Issued): Promise<string> {
  return crypto.sign('sha256', data, await nodePrivateKey(signer.keys)).toString('base64');
}

// Signing chain trusted by the station: a ManufacturerRootCertificate in its store.
async function trustedSigner(h: Harness): Promise<Issued> {
  const root = await rootCa('CN=Test Manufacturer Root');
  const rootCert = new crypto.X509Certificate(root.pem);
  const hashData = certificateHashData(rootCert, rootCert);
  (priv(h, 'installedCertificatesCache') as { set: (k: string, v: unknown) => void }).set(
    hashData.serialNumber,
    {
      certificateType: 'ManufacturerRootCertificate',
      certificateHashData: { ...hashData },
      certificate: root.pem,
    },
  );
  return leaf(root, 'CN=Firmware Signer');
}

function stubFetch(body: Buffer | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    body == null ? new Response('nope', { status: 404 }) : new Response(new Uint8Array(body)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function statuses(h: Harness, action: string): string[] {
  return h.sent(action).map((p) => p['status'] as string);
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('UpdateFirmware OCPP 2.1 (L01)', () => {
  it('rejects a request without signing certificate or signature', async () => {
    const h = await makeHarness();
    expect(
      await h.invoke('UpdateFirmware', { requestId: 1, firmware: { location: 'http://x/fw' } }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'MissingParam' } });
  });

  it('returns InvalidCertificate and a security event for an untrusted signer', async () => {
    const h = await makeHarness();
    const stranger = await rootCa('CN=Stranger');
    const res = await h.invoke('UpdateFirmware', {
      requestId: 2,
      firmware: {
        location: 'http://x/fw',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: stranger.pem,
        signature: 'AAAA',
      },
    });
    expect(res).toEqual({ status: 'InvalidCertificate' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('SecurityEventNotification').map((p) => p['type'])).toContain(
      'InvalidFirmwareSigningCertificate',
    );
  });

  it('downloads, verifies, installs, reboots with FirmwareUpdate and reports Installed', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    const image = firmwareImage('2.0.0');
    const fetchMock = stubFetch(image);
    const res = await h.invoke('UpdateFirmware', {
      requestId: 9,
      firmware: {
        location: 'https://fw.example/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: await sign(image, signer),
      },
    });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual([
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'Installing',
      'Installed',
    ]);
    expect(h.sent('FirmwareStatusNotification').every((p) => p['requestId'] === 9)).toBe(true);
    expect(h.sent('BootNotification')[0]).toMatchObject({ reason: 'FirmwareUpdate' });
    expect(h.sent('SecurityEventNotification').map((p) => p['type'])).toContain('FirmwareUpdated');
    expect(
      (h.sim as unknown as { config: { firmwareVersion: string } }).config.firmwareVersion,
    ).toBe('2.0.0');
    expect(priv(h, 'firmwareUpdateStatus')).toBe('Idle');
    expect(priv(h, 'activeFirmwareUpdate21')).toBeNull();
  });

  it('reports DownloadScheduled before a future retrieveDateTime', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    const image = firmwareImage('2.0.1');
    stubFetch(image);
    await h.invoke('UpdateFirmware', {
      requestId: 3,
      firmware: {
        location: 'https://fw.example/fw.bin',
        retrieveDateTime: new Date(Date.now() + 3000).toISOString(),
        installDateTime: new Date(Date.now() + 6000).toISOString(),
        signingCertificate: signer.pem,
        signature: await sign(image, signer),
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual(['DownloadScheduled']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual([
      'DownloadScheduled',
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'InstallScheduled',
    ]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(statuses(h, 'FirmwareStatusNotification').at(-1)).toBe('Installed');
  });

  it('reports DownloadFailed when the download fails', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    stubFetch(null);
    await h.invoke('UpdateFirmware', {
      requestId: 4,
      firmware: {
        location: 'https://fw.example/missing.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: 'AAAA',
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual(['Downloading', 'DownloadFailed']);
    expect(priv(h, 'activeFirmwareUpdate21')).toBeNull();
  });

  it('reports DownloadFailed without fetching for a non-http location', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    const fetchMock = stubFetch(firmwareImage('x'));
    await h.invoke('UpdateFirmware', {
      requestId: 5,
      firmware: {
        location: 'ftp://fw.example/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: 'AAAA',
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual(['Downloading', 'DownloadFailed']);
  });

  it('reports InvalidSignature and a security event for a bad signature', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    const image = firmwareImage('2.0.2');
    stubFetch(image);
    await h.invoke('UpdateFirmware', {
      requestId: 6,
      firmware: {
        location: 'https://fw.example/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: await sign(Buffer.from('other'), signer),
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual([
      'Downloading',
      'Downloaded',
      'InvalidSignature',
    ]);
    expect(h.sent('SecurityEventNotification').map((p) => p['type'])).toContain(
      'InvalidFirmwareSignature',
    );
  });

  it('reports InstallVerificationFailed for an image that is not simulator firmware', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    const image = Buffer.from('not json');
    stubFetch(image);
    await h.invoke('UpdateFirmware', {
      requestId: 7,
      firmware: {
        location: 'https://fw.example/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: await sign(image, signer),
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses(h, 'FirmwareStatusNotification').slice(-2)).toEqual([
      'Installing',
      'InstallVerificationFailed',
    ]);
    expect(h.sent('BootNotification')).toHaveLength(0);
  });

  it('a second request before installing returns AcceptedCanceled and supersedes the first', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    const image = firmwareImage('3.0.0');
    stubFetch(image);
    const firmware = {
      location: 'https://fw.example/fw.bin',
      retrieveDateTime: new Date(Date.now() + 60_000).toISOString(),
      signingCertificate: signer.pem,
      signature: await sign(image, signer),
    };
    expect(await h.invoke('UpdateFirmware', { requestId: 10, firmware })).toEqual({
      status: 'Accepted',
    });
    expect(
      await h.invoke('UpdateFirmware', {
        requestId: 11,
        firmware: { ...firmware, retrieveDateTime: new Date().toISOString() },
      }),
    ).toEqual({ status: 'AcceptedCanceled' });
    await vi.advanceTimersByTimeAsync(62_000);
    const first = h.sent('FirmwareStatusNotification').filter((p) => p['requestId'] === 10);
    expect(first.map((p) => p['status'])).toEqual(['DownloadScheduled']);
    const second = h.sent('FirmwareStatusNotification').filter((p) => p['requestId'] === 11);
    expect(second.map((p) => p['status']).at(-1)).toBe('Installed');
  });

  it('waits for the transaction to end and blocks idle connectors when new sessions are not allowed', async () => {
    const h = await makeHarness({
      config: {
        evses: [
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
            connectorType: 'ac_type2',
            maxPowerW: 22000,
            phases: 3,
            voltage: 230,
          },
        ],
      },
    });
    h.sim.setConfigValue('ChargingStation.AllowNewSessionsPendingFirmwareUpdate', 'false');
    const signer = await trustedSigner(h);
    const image = firmwareImage('4.0.0');
    stubFetch(image);
    const ctx1 = (priv(h, 'evseContexts') as Map<number, { transactionId: string | null }>).get(1);
    if (ctx1 == null) throw new Error('no evse 1');
    ctx1.transactionId = 'TX-RUNNING';
    await h.invoke('UpdateFirmware', {
      requestId: 12,
      firmware: {
        location: 'https://fw.example/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: await sign(image, signer),
      },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses(h, 'FirmwareStatusNotification').at(-1)).toBe('InstallScheduled');
    expect(h.sent('StatusNotification')).toContainEqual(
      expect.objectContaining({ evseId: 2, connectorStatus: 'Unavailable' }),
    );
    expect(h.sent('StatusNotification')).not.toContainEqual(
      expect.objectContaining({ evseId: 1, connectorStatus: 'Unavailable' }),
    );
    // Once the transaction ends, the installation proceeds.
    ctx1.transactionId = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses(h, 'FirmwareStatusNotification').at(-1)).toBe('Installed');
    expect((priv(h, 'evseConnectorStatus') as Map<number, string>).get(2)).toBe('Available');
    expect((priv(h, 'firmwareBlockedEvses') as Set<number>).size).toBe(0);
  });

  it('rejects a new request while installing', async () => {
    const h = await makeHarness();
    const signer = await trustedSigner(h);
    h.p['activeFirmwareUpdate21'] = { requestId: 1, installing: true };
    expect(
      await h.invoke('UpdateFirmware', {
        requestId: 2,
        firmware: {
          location: 'https://fw.example/fw.bin',
          retrieveDateTime: new Date().toISOString(),
          signingCertificate: signer.pem,
          signature: 'AAAA',
        },
      }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'TxInProgress' } });
  });

  it('releases blocked connectors when installation verification fails', async () => {
    const h = await makeHarness();
    (priv(h, 'firmwareBlockedEvses') as Set<number>).add(1);
    (priv(h, 'evseConnectorStatus') as Map<number, string>).set(1, 'Unavailable');
    await call(h, 'releaseFirmwareBlockedConnectors');
    expect((priv(h, 'evseConnectorStatus') as Map<number, string>).get(1)).toBe('Available');
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({
      evseId: 1,
      connectorStatus: 'Available',
    });
  });
});

describe('UpdateFirmware OCPP 1.6 (simulated)', () => {
  it('runs Downloading, Downloaded, Installing, boot, Installed', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(
      await h.invoke('UpdateFirmware', {
        location: 'http://fw.example/fw.bin',
        retrieveDate: new Date().toISOString(),
      }),
    ).toEqual({});
    await vi.advanceTimersByTimeAsync(3000);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual([
      'Downloading',
      'Downloaded',
      'Installing',
      'Installed',
    ]);
    expect(h.sent('FirmwareStatusNotification')[0]).toEqual({ status: 'Downloading' });
    expect(h.sent('BootNotification')).toHaveLength(1);
    expect(h.sent('BootNotification')[0]).toMatchObject({ chargePointVendor: 'V' });
    expect(priv(h, 'firmwareUpdateStatus')).toBe('Idle');
  });

  it('reports DownloadFailed for an unreachable location', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('UpdateFirmware', {
      location: 'http://does_not_exist/fw.bin',
      retrieveDate: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual(['Downloading', 'DownloadFailed']);
    expect(priv(h, 'firmwareUpdateStatus')).toBe('Idle');
  });

  it('reports InstallationFailed for invalid firmware', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('UpdateFirmware', {
      location: 'http://fw.example/invalid_firmware.bin',
      retrieveDate: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual([
      'Downloading',
      'Downloaded',
      'InstallationFailed',
    ]);
    expect(h.sent('BootNotification')).toHaveLength(0);
  });

  it('stops reporting once the simulator is destroyed', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('UpdateFirmware', {
      location: 'http://fw.example/fw.bin',
      retrieveDate: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(600);
    h.p['destroyed'] = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(statuses(h, 'FirmwareStatusNotification')).toEqual(['Downloading']);
  });

  it('resets the status to Idle when a notification fails', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.sendCall.mockImplementation(async (action: string) => {
      if (action === 'FirmwareStatusNotification') throw new Error('offline');
      return {};
    });
    await h.invoke('UpdateFirmware', {
      location: 'http://fw.example/fw.bin',
      retrieveDate: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(priv(h, 'firmwareUpdateStatus')).toBe('Idle');
  });
});

describe('SignedUpdateFirmware OCPP 1.6', () => {
  async function install16Root(h: Harness): Promise<Issued> {
    const root = await rootCa('CN=Mfr Root 16');
    expect(
      await h.invoke('InstallCertificate', {
        certificateType: 'ManufacturerRootCertificate',
        certificate: root.pem,
      }),
    ).toEqual({ status: 'Accepted' });
    return leaf(root, 'CN=Signer 16');
  }

  it('is NotSupported on OCPP 2.1', async () => {
    const h = await makeHarness();
    expect(await h.invoke('SignedUpdateFirmware', { requestId: 1, firmware: {} })).toEqual({
      status: 'NotSupported',
    });
  });

  it('verifies, installs, reboots and reports the signed firmware statuses in order', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const signer = await install16Root(h);
    const image = firmwareImage('1.6.1');
    stubFetch(image);
    expect(
      await h.invoke('SignedUpdateFirmware', {
        requestId: 21,
        firmware: {
          location: 'https://fw.example/fw.bin',
          retrieveDateTime: new Date(Date.now() + 1000).toISOString(),
          installDateTime: new Date(Date.now() + 2000).toISOString(),
          signingCertificate: signer.pem,
          signature: await sign(image, signer),
        },
      }),
    ).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses(h, 'SignedFirmwareStatusNotification')).toEqual([
      'DownloadScheduled',
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'InstallScheduled',
      'Installing',
      'Installed',
    ]);
    expect(h.sent('SignedFirmwareStatusNotification').every((p) => p['requestId'] === 21)).toBe(
      true,
    );
    expect(h.sent('SecurityEventNotification').map((p) => p['type'])).toContain('FirmwareUpdated');
    expect(priv(h, 'activeSignedFirmwareRequestId')).toBeNull();
  });

  it('reports DownloadFailed when the download fails after the retries', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const signer = await install16Root(h);
    const fetchMock = stubFetch(null);
    await h.invoke('SignedUpdateFirmware', {
      requestId: 22,
      retries: 2,
      retryInterval: 1,
      firmware: {
        location: 'https://fw.example/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: 'AAAA',
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(statuses(h, 'SignedFirmwareStatusNotification')).toEqual([
      'Downloading',
      'DownloadFailed',
    ]);
  });

  it('reports InvalidSignature for a signature from another key', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const signer = await install16Root(h);
    const other = await rootCa('CN=Other Key');
    const image = firmwareImage('1.6.2');
    stubFetch(image);
    await h.invoke('SignedUpdateFirmware', {
      requestId: 23,
      firmware: {
        location: 'https://fw.example/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: signer.pem,
        signature: await sign(image, other),
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses(h, 'SignedFirmwareStatusNotification')).toEqual([
      'Downloading',
      'Downloaded',
      'InvalidSignature',
    ]);
    expect(h.sent('SecurityEventNotification').map((p) => p['type'])).toContain(
      'InvalidFirmwareSignature',
    );
  });

  it('a second request returns AcceptedCanceled and the first stops reporting', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const signer = await install16Root(h);
    const image = firmwareImage('1.6.3');
    stubFetch(image);
    const firmware = {
      location: 'https://fw.example/fw.bin',
      retrieveDateTime: new Date(Date.now() + 10_000).toISOString(),
      signingCertificate: signer.pem,
      signature: await sign(image, signer),
    };
    expect(await h.invoke('SignedUpdateFirmware', { requestId: 30, firmware })).toEqual({
      status: 'Accepted',
    });
    expect(await h.invoke('SignedUpdateFirmware', { requestId: 31, firmware })).toEqual({
      status: 'AcceptedCanceled',
    });
    await vi.advanceTimersByTimeAsync(12_000);
    const first = h.sent('SignedFirmwareStatusNotification').filter((p) => p['requestId'] === 30);
    expect(first.map((p) => p['status'])).toEqual(['DownloadScheduled']);
    const second = h.sent('SignedFirmwareStatusNotification').filter((p) => p['requestId'] === 31);
    expect(second.map((p) => p['status']).at(-1)).toBe('Installed');
  });
});

describe('OCPP 1.6 certificates', () => {
  it('rejects an unsupported certificate type and an issuer-less intermediate', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const root = await rootCa('CN=Root');
    expect(
      await h.invoke('InstallCertificate', {
        certificateType: 'V2GRootCertificate',
        certificate: root.pem,
      }),
    ).toEqual({ status: 'Rejected' });
  });

  it('fails when the certificate store is full', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.sim.setConfigValue('CertificateStoreMaxLength', '1');
    const a = await rootCa('CN=A');
    const b = await rootCa('CN=B');
    expect(
      await h.invoke('InstallCertificate', {
        certificateType: 'CentralSystemRootCertificate',
        certificate: a.pem,
      }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await h.invoke('InstallCertificate', {
        certificateType: 'CentralSystemRootCertificate',
        certificate: b.pem,
      }),
    ).toEqual({ status: 'Failed' });
  });

  it('DeleteCertificate returns NotFound for missing or unknown hash algorithms', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await h.invoke('DeleteCertificate', {})).toEqual({ status: 'NotFound' });
    expect(
      await h.invoke('DeleteCertificate', {
        certificateHashData: { hashAlgorithm: 'MD5', serialNumber: '01' },
      }),
    ).toEqual({ status: 'NotFound' });
  });

  it('ExtendedTriggerMessage is NotSupported on OCPP 2.1', async () => {
    const h = await makeHarness();
    expect(await h.invoke('ExtendedTriggerMessage', { requestedMessage: 'Heartbeat' })).toEqual({
      status: 'NotSupported',
    });
  });

  it('ExtendedTriggerMessage sends LogStatusNotification and Heartbeat', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(
      await h.invoke('ExtendedTriggerMessage', { requestedMessage: 'LogStatusNotification' }),
    ).toEqual({ status: 'Accepted' });
    expect(await h.invoke('ExtendedTriggerMessage', { requestedMessage: 'Heartbeat' })).toEqual({
      status: 'Accepted',
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(h.sent('LogStatusNotification')).toEqual([{ status: 'Idle' }]);
    expect(h.sent('Heartbeat')).toHaveLength(1);
  });

  it('ExtendedTriggerMessage logs a failed triggered message', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.sendCall.mockImplementation(async (action: string) => {
      if (action === 'LogStatusNotification') throw new Error('offline');
      return {};
    });
    await h.invoke('ExtendedTriggerMessage', { requestedMessage: 'LogStatusNotification' });
    await vi.advanceTimersByTimeAsync(150);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('CertificateSigned installs a chain for the pending key and reconnects on profile 3', async () => {
    const root = await rootCa('CN=CSMS Root 16');
    const h = await makeHarness({
      protocol: 'ocpp1.6',
      config: { caCert: root.pem, securityProfile: 3 },
    });
    await call(h, 'requestChargePointCertificate16');
    const csrPem = h.sent('SignCertificate')[0]?.['csr'] as string;
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    const publicKey = await csr.publicKey.export(ALG, ['verify']);
    const signed = await leaf(root, 'CN=SN', publicKey);
    const update = vi.fn();
    Object.defineProperty(h.sim.client, 'updateConnection', { value: update, writable: true });
    Object.defineProperty(h.sim.client, 'connection', {
      value: { securityProfile: 3 },
      writable: true,
    });
    const chain = signed.pem + '\n' + root.pem;
    expect(await h.invoke('CertificateSigned', { certificateChain: chain })).toEqual({
      status: 'Accepted',
    });
    const cfg = (h.sim as unknown as { config: { clientCert?: string; clientKey?: string } })
      .config;
    expect(cfg.clientCert).toBe(chain);
    expect(cfg.clientKey).toContain('PRIVATE KEY');
    expect(update).toHaveBeenCalledWith({ clientCert: chain, clientKey: cfg.clientKey });
    expect(priv(h, 'pendingChargePointKey16')).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sim.client.simulateConnectionLoss).toHaveBeenCalled();
  });

  it('logs a failed client certificate save', async () => {
    const h = await makeHarness({
      protocol: 'ocpp1.6',
      sql: Object.assign(() => Promise.reject(new Error('db down')), {
        json: (v: unknown) => v,
      }) as unknown as ReturnType<typeof stubSql>,
      load: false,
    });
    await call(h, 'persistClientCertificate');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});

describe('OCPP 2.1 certificate signing (A02)', () => {
  async function csrKey(h: Harness, index = 0): Promise<CryptoKey> {
    const csrPem = h.sent('SignCertificate')[index]?.['csr'] as string;
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    return csr.publicKey.export(ALG, ['verify']);
  }

  it('TriggerMessage SignChargingStationCertificate sends a CSR with the serial number as CN', async () => {
    const h = await makeHarness();
    await call(h, 'handleTriggerMessage', 'SignChargingStationCertificate', {});
    const sent = h.sent('SignCertificate');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['certificateType']).toBe('ChargingStationCertificate');
    const csr = new x509.Pkcs10CertificateRequest(sent[0]?.['csr'] as string);
    expect(csr.subject).toContain('CN=SN');
  });

  it('resends the CSR with a doubling wait while no certificate arrives', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('SecurityCtrlr.CertSigningWaitMinimum', '10');
    h.sim.setConfigValue('SecurityCtrlr.CertSigningRepeatTimes', '1');
    await call(h, 'requestCertificateSigning', 'ChargingStationCertificate');
    expect(h.sent('SignCertificate')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent('SignCertificate')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(h.sent('SignCertificate')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent('SignCertificate')).toHaveLength(3);
    // RepeatTimes exhausted: no further resend.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.sent('SignCertificate')).toHaveLength(3);
    expect(
      h.sent('SignCertificate').every((p) => p['csr'] === h.sent('SignCertificate')[0]?.['csr']),
    ).toBe(true);
  });

  it('does not schedule a resend when the CSMS rejects the CSR', async () => {
    const h = await makeHarness({
      respond: (action) => (action === 'SignCertificate' ? { status: 'Rejected' } : undefined),
    });
    h.sim.setConfigValue('SecurityCtrlr.CertSigningWaitMinimum', '5');
    h.sim.setConfigValue('SecurityCtrlr.CertSigningRepeatTimes', '3');
    await call(h, 'requestCertificateSigning', 'V2GCertificate');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent('SignCertificate')).toHaveLength(1);
    expect(h.sent('SignCertificate')[0]?.['certificateType']).toBe('V2GCertificate');
  });

  it('accepts a ChargingStationCertificate for the CSR key, stops resending and reconnects', async () => {
    const root = await rootCa('CN=CSMS Root 21');
    const h = await makeHarness({ config: { caCert: root.pem } });
    h.sim.setConfigValue('SecurityCtrlr.CertSigningWaitMinimum', '10');
    h.sim.setConfigValue('SecurityCtrlr.CertSigningRepeatTimes', '2');
    await call(h, 'requestCertificateSigning', 'ChargingStationCertificate');
    const signed = await leaf(root, 'CN=SN', await csrKey(h));
    const update = vi.fn();
    Object.defineProperty(h.sim.client, 'updateConnection', { value: update, writable: true });
    expect(
      await h.invoke('CertificateSigned', {
        certificateChain: signed.pem,
        certificateType: 'ChargingStationCertificate',
      }),
    ).toEqual({ status: 'Accepted' });
    const cfg = (h.sim as unknown as { config: { clientCert?: string } }).config;
    expect(cfg.clientCert).toBe(signed.pem);
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sim.client.reconnectNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent('SignCertificate')).toHaveLength(1);
  });

  it('stores a V2GCertificate chain issued by an installed V2G root', async () => {
    const h = await makeHarness();
    const v2gRoot = await rootCa('CN=V2G Root');
    const rootCert = new crypto.X509Certificate(v2gRoot.pem);
    const rootHash = certificateHashData(rootCert, rootCert);
    const cache = priv(h, 'installedCertificatesCache') as {
      set: (k: string, v: unknown) => void;
      values: () => Iterable<{ certificateType: string; certificate?: string }>;
    };
    cache.set(rootHash.serialNumber, {
      certificateType: 'V2GRootCertificate',
      certificateHashData: { ...rootHash },
      certificate: v2gRoot.pem,
    });
    await call(h, 'requestCertificateSigning', 'V2GCertificate');
    const csr = new x509.Pkcs10CertificateRequest(h.sent('SignCertificate')[0]?.['csr'] as string);
    expect(csr.subject).toContain('CN=TEST-SIM');
    const signed = await leaf(v2gRoot, 'CN=TEST-SIM', await csrKey(h));
    expect(
      await h.invoke('CertificateSigned', {
        certificateChain: signed.pem,
        certificateType: 'V2GCertificate',
      }),
    ).toEqual({ status: 'Accepted' });
    const stored = [...cache.values()].filter(
      (e) => e.certificateType === 'V2GCertificateChain' && e.certificate === signed.pem,
    );
    expect(stored).toHaveLength(1);
  });

  it('rejects a chain whose key matches no CSR and raises InvalidChargingStationCertificate', async () => {
    const root = await rootCa('CN=CSMS Root X');
    const h = await makeHarness({ config: { caCert: root.pem } });
    const stray = await leaf(root, 'CN=SN');
    expect(await h.invoke('CertificateSigned', { certificateChain: stray.pem })).toEqual({
      status: 'Rejected',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('SecurityEventNotification').map((p) => p['type'])).toContain(
      'InvalidChargingStationCertificate',
    );
  });

  it('logs when the security event for a rejected chain cannot be sent', async () => {
    const h = await makeHarness({
      respond: (action) => {
        if (action === 'SecurityEventNotification') throw new Error('link down');
        return undefined;
      },
    });
    expect(await h.invoke('CertificateSigned', { certificateChain: 'garbage' })).toEqual({
      status: 'Rejected',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('link down'));
  });
});

describe('log and diagnostics upload', () => {
  it('GetLog to a nonexistent location reports UploadFailure', async () => {
    const h = await makeHarness();
    const res = await h.invoke('GetLog', {
      requestId: 5,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: 'https://nonexistent.example/upload' },
    });
    expect(res['status']).toBe('Accepted');
    await vi.advanceTimersByTimeAsync(600);
    expect(h.sent('LogStatusNotification')).toContainEqual(
      expect.objectContaining({ status: 'UploadFailure', requestId: 5 }),
    );
    expect(priv(h, 'logUploadStatus')).toBe('Idle');
    expect(priv(h, 'activeLogUploadRequestId')).toBeNull();
  });

  it('1.6 GetDiagnostics uploads and reports Uploading then Uploaded', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await h.invoke('GetDiagnostics', { location: 'ftp://diag.example/up' })).toEqual({
      fileName: 'diagnostics.txt',
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(statuses(h, 'DiagnosticsStatusNotification')).toEqual(['Uploading', 'Uploaded']);
  });

  it('1.6 GetDiagnostics to an unreachable location reports UploadFailed', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('GetDiagnostics', { location: 'ftp://127.0.0.1/failedLocation' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(statuses(h, 'DiagnosticsStatusNotification')).toEqual(['Uploading', 'UploadFailed']);
  });

  it('1.6 GetDiagnostics stops after the simulator is destroyed', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('GetDiagnostics', { location: 'ftp://diag.example/up' });
    await vi.advanceTimersByTimeAsync(600);
    h.p['destroyed'] = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses(h, 'DiagnosticsStatusNotification')).toEqual(['Uploading']);
  });
});

describe('reset and reconnect', () => {
  it('2.1 Immediate reset stops the running transaction with ImmediateReset and reboots', async () => {
    const h = await makeHarness();
    const stop = vi.spyOn(h.sim, 'stopCharging').mockResolvedValue(undefined);
    Object.defineProperty(h.sim, 'getActiveTransaction', {
      value: vi.fn(async () => ({ transactionId: 'T' })),
      writable: true,
      configurable: true,
    });
    const run = call(h, 'simulateReset', 'Immediate') as Promise<void>;
    await vi.advanceTimersByTimeAsync(600);
    await run;
    expect(stop).toHaveBeenCalledWith(1, 'ImmediateReset');
    expect(h.sent('BootNotification')[0]).toMatchObject({ reason: 'RemoteReset' });
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorStatus: 'Available' });
  });

  it('first successful connection after a failed start runs the boot sequence', async () => {
    const h = await makeHarness();
    h.p['initialBootDone'] = false;
    await call(h, 'onReconnect');
    expect(h.sent('BootNotification')[0]).toMatchObject({ reason: 'PowerUp' });
  });

  it('logs a failed boot after reconnect', async () => {
    const h = await makeHarness({
      respond: (action) => {
        if (action === 'BootNotification') throw new Error('boot refused');
        return undefined;
      },
    });
    h.p['initialBootDone'] = false;
    await call(h, 'onReconnect');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('boot refused'));
  });

  it('2.1 reconnect after an offline period drops profiles invalid after offline', async () => {
    const h = await makeHarness();
    h.p['initialBootDone'] = true;
    h.p['bootStatus'] = 'Accepted';
    h.p['offlineSince'] = Date.now() - 120_000;
    const spy = vi.fn();
    Object.defineProperty(h.sim, 'invalidateProfilesAfterOffline', {
      value: spy,
      writable: true,
      configurable: true,
    });
    await call(h, 'onReconnect');
    expect(spy).toHaveBeenCalledWith(expect.any(Number));
    expect(spy.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(120_000);
  });
});
