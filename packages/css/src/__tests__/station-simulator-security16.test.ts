// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as x509 from '@peculiar/x509';
import type postgres from 'postgres';
import { StationSimulator } from '../station-simulator.js';
import { certificateHashData } from '../lib/station-pki.js';
import { makeConfig } from './sim-test-helpers.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 24 * 60 * 60 * 1000;

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

async function rootPem(name: string, ca = true): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto
      .randomBytes(8)
      .toString('hex')
      .replace(/^[89a-f]/, '1'),
    name,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(ca, undefined, true),
      new x509.KeyUsagesExtension(
        ca ? x509.KeyUsageFlags.keyCertSign : x509.KeyUsageFlags.digitalSignature,
        true,
      ),
    ],
  });
  return cert.toString('pem');
}

interface Internals {
  handleCsmsCommand: (
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  seedDefaultConfigVariables: () => void;
  seedCertificates16: () => void;
}

function makeSimulator(caCert?: string): {
  sim: StationSimulator;
  sendCall: ReturnType<typeof vi.fn>;
} {
  const sim = new StationSimulator(
    makeConfig({
      ocppProtocol: 'ocpp1.6',
      securityProfile: 2,
      ...(caCert != null ? { caCert } : {}),
    }),
    noopSql(),
  );
  const internals = sim as unknown as Internals;
  internals.seedDefaultConfigVariables();
  internals.seedCertificates16();
  const sendCall = vi.fn(async () => ({ status: 'Accepted' }));
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  return { sim, sendCall };
}

function command(
  sim: StationSimulator,
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (sim as unknown as Internals).handleCsmsCommand('msg-1', action, payload);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('StationSimulator OCPP 1.6 Security Whitepaper', () => {
  it('installs a root certificate and lists its hash data per certificate type', async () => {
    const { sim } = makeSimulator();
    const pem = await rootPem('CN=Manufacturer Root');
    const cert = new crypto.X509Certificate(pem);

    expect(
      await command(sim, 'GetInstalledCertificateIds', {
        certificateType: 'ManufacturerRootCertificate',
      }),
    ).toEqual({ status: 'NotFound' });
    expect(
      await command(sim, 'InstallCertificate', {
        certificateType: 'ManufacturerRootCertificate',
        certificate: pem,
      }),
    ).toEqual({ status: 'Accepted' });

    const list = await command(sim, 'GetInstalledCertificateIds', {
      certificateType: 'ManufacturerRootCertificate',
    });
    expect(list).toEqual({
      status: 'Accepted',
      certificateHashData: [{ ...certificateHashData(cert, cert) }],
    });
    expect(
      await command(sim, 'GetInstalledCertificateIds', {
        certificateType: 'CentralSystemRootCertificate',
      }),
    ).toEqual({ status: 'NotFound' });
  });

  it('rejects a self-signed certificate that is not a CA', async () => {
    const { sim } = makeSimulator();
    expect(
      await command(sim, 'InstallCertificate', {
        certificateType: 'CentralSystemRootCertificate',
        certificate: await rootPem('CN=Not A CA', false),
      }),
    ).toEqual({ status: 'Rejected' });
  });

  it('rejects a certificate that does not parse or is not a root without an installed issuer', async () => {
    const { sim } = makeSimulator();
    expect(
      await command(sim, 'InstallCertificate', {
        certificateType: 'CentralSystemRootCertificate',
        certificate: 'garbage',
      }),
    ).toEqual({ status: 'Rejected' });
  });

  it('deletes an installed certificate by hash data and refuses the provisioned trust anchor', async () => {
    const provisioned = await rootPem('CN=Provisioned Root');
    const { sim } = makeSimulator(provisioned);
    const extra = await rootPem('CN=Extra Root');
    await command(sim, 'InstallCertificate', {
      certificateType: 'CentralSystemRootCertificate',
      certificate: extra,
    });
    const extraCert = new crypto.X509Certificate(extra);
    const provisionedCert = new crypto.X509Certificate(provisioned);

    expect(
      await command(sim, 'DeleteCertificate', {
        certificateHashData: certificateHashData(extraCert, extraCert, 'SHA384'),
      }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await command(sim, 'DeleteCertificate', {
        certificateHashData: certificateHashData(extraCert, extraCert),
      }),
    ).toEqual({ status: 'NotFound' });
    expect(
      await command(sim, 'DeleteCertificate', {
        certificateHashData: certificateHashData(provisionedCert, provisionedCert),
      }),
    ).toEqual({ status: 'Failed' });
  });

  it('rejects CertificateSigned without a pending CSR and reports InvalidChargePointCertificate', async () => {
    const { sim, sendCall } = makeSimulator();
    const pem = await rootPem('CN=Some Cert');
    expect(await command(sim, 'CertificateSigned', { certificateChain: pem })).toEqual({
      status: 'Rejected',
    });
    expect(sendCall).toHaveBeenCalledWith(
      'SecurityEventNotification',
      expect.objectContaining({ type: 'InvalidChargePointCertificate' }),
    );
  });

  it('sends a CSR with the serial number as CN for ExtendedTriggerMessage SignChargePointCertificate', async () => {
    vi.useFakeTimers();
    const { sim, sendCall } = makeSimulator();
    expect(
      await command(sim, 'ExtendedTriggerMessage', {
        requestedMessage: 'SignChargePointCertificate',
      }),
    ).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(sendCall).toHaveBeenCalledWith('SignCertificate', expect.anything());
    });
    const call = sendCall.mock.calls.find((c) => c[0] === 'SignCertificate') as unknown as [
      string,
      { csr: string },
    ];
    const csr = new x509.Pkcs10CertificateRequest(call[1].csr);
    expect(csr.subject).toBe('CN=SN, O=V');
  });

  it('answers ExtendedTriggerMessage for unknown messages and connectors', async () => {
    const { sim } = makeSimulator();
    expect(
      await command(sim, 'ExtendedTriggerMessage', { requestedMessage: 'DataTransfer' }),
    ).toEqual({ status: 'NotImplemented' });
    expect(
      await command(sim, 'ExtendedTriggerMessage', {
        requestedMessage: 'StatusNotification',
        connectorId: 9,
      }),
    ).toEqual({ status: 'Rejected' });
  });

  it('refuses SignedUpdateFirmware when the signing certificate has no ManufacturerRootCertificate', async () => {
    const { sim, sendCall } = makeSimulator();
    const resp = await command(sim, 'SignedUpdateFirmware', {
      requestId: 7,
      firmware: {
        location: 'http://127.0.0.1:1/fw.bin',
        retrieveDateTime: new Date().toISOString(),
        signingCertificate: await rootPem('CN=Unknown Signer'),
        signature: 'AAAA',
      },
    });
    expect(resp).toEqual({ status: 'InvalidCertificate' });
    expect(sendCall).toHaveBeenCalledWith(
      'SecurityEventNotification',
      expect.objectContaining({ type: 'InvalidFirmwareSigningCertificate' }),
    );
  });

  it('sends LogStatusNotification with the GetLog requestId', async () => {
    const { sim, sendCall } = makeSimulator();
    await sim.sendLogStatusNotification('Uploading', 42);
    await sim.sendLogStatusNotification('Idle');
    expect(sendCall).toHaveBeenCalledWith('LogStatusNotification', {
      status: 'Uploading',
      requestId: 42,
    });
    expect(sendCall).toHaveBeenCalledWith('LogStatusNotification', { status: 'Idle' });
  });

  it('seeds the provisioned CA as CentralSystemRootCertificate', async () => {
    const provisioned = await rootPem('CN=Provisioned Root');
    const { sim } = makeSimulator(provisioned);
    const list = await command(sim, 'GetInstalledCertificateIds', {
      certificateType: 'CentralSystemRootCertificate',
    });
    expect(list['status']).toBe('Accepted');
    expect(list['certificateHashData']).toHaveLength(1);
  });
});
