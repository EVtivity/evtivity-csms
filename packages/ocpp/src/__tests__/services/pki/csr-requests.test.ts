// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as x509 from '@peculiar/x509';

const clientMock = vi.fn();

vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => clientMock(...args) as unknown,
}));

const { isValidCsr, markCsrFailed, recordCsrRequest } =
  await import('../../../services/pki/csr-requests.js');

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

async function makeCsr(): Promise<string> {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=CS-001,O=EVtivity',
    keys,
    signingAlgorithm: alg,
  });
  return csr.toString('pem');
}

beforeEach(() => {
  clientMock.mockReset();
});

describe('isValidCsr', () => {
  it('accepts a PEM PKCS#10 request with a valid signature', async () => {
    expect(await isValidCsr(await makeCsr())).toBe(true);
  });

  it('refuses text that is not a CSR', async () => {
    expect(await isValidCsr('csr-data')).toBe(false);
    expect(
      await isValidCsr(
        '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----',
      ),
    ).toBe(false);
  });

  it('refuses a CSR whose signature does not verify', async () => {
    const pem = await makeCsr();
    const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    der[der.length - 5] = (der[der.length - 5] ?? 0) ^ 0xff;
    const broken = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----`;
    expect(await isValidCsr(broken)).toBe(false);
  });
});

describe('recordCsrRequest', () => {
  it('inserts a pending row with the station and requestId and returns its id', async () => {
    clientMock.mockResolvedValueOnce([{ id: 8 }]);
    const id = await recordCsrRequest({
      stationDbId: 'sta_1',
      csr: 'pem',
      certificateType: 'V2GCertificate',
      requestId: 4,
    });
    expect(id).toBe(8);
    const [strings, ...values] = clientMock.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain("'pending'");
    expect(values).toEqual(['pem', 'V2GCertificate', 'sta_1', 4]);
  });
});

describe('markCsrFailed', () => {
  it('rejects only an open CSR and keeps the reason', async () => {
    clientMock.mockResolvedValueOnce([]);
    await markCsrFailed(8, 'Hubject CSR signing failed: 500');
    const [strings, ...values] = clientMock.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain("status IN ('pending', 'submitted')");
    expect(values).toEqual(['Hubject CSR signing failed: 500', 8]);
  });
});
