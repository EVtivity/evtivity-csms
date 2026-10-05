// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { buildResponse, issueCert, requestDataFor, type TestCert } from './ocsp-fixtures.js';

let caRows: { certificate: string; certificateType: string }[] = [];

vi.mock('@evtivity/database', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(caRows) }),
    }),
  },
  pkiCaCertificates: {
    certificate: 'certificate',
    certificateType: 'certificate_type',
    status: 'status',
  },
  getOcspAllowedPrivateHosts: () => Promise.resolve([]),
}));

const getOcspStatus =
  vi.fn<
    (data: {
      serialNumber: string;
      responderURL: string;
    }) => Promise<{ status: 'Accepted' | 'Failed'; ocspResult: string }>
  >();

vi.mock('../../../services/pki/provider-factory.js', () => ({
  getPkiProvider: () => Promise.resolve({ getOcspStatus }),
}));

// The local contract CA (none by default): its MO certificates and the
// status of certificates it issued.
let localMo: { roots: unknown[]; contractIssuers: unknown[]; all: unknown[] } | null = null;
const localCertificateStatus = vi.fn<(d: { serialNumber: string }) => Promise<string | null>>();
vi.mock('../../../services/pki/local-contract-status.js', () => ({
  getLocalMoCertificates: () => Promise.resolve(localMo),
  localCertificateStatus: (d: { serialNumber: string }) => localCertificateStatus(d),
}));

import { buildOcspRequest } from '../../../services/pki/ocsp.js';
import {
  applyContractCertificateVerdict,
  clearContractValidationCaCache,
  validateContractCertificate,
} from '../../../services/pki/contract-certificate-validation.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof validateContractCertificate>[1];

const OCSP_URL = 'https://ocsp.example.com/';
let moRoot: TestCert;
let moSub1: TestCert;
let moSub2: TestCert;
let contract: TestCert;

beforeAll(async () => {
  moRoot = await issueCert('CN=MO Root', null, { ca: true });
  moSub1 = await issueCert('CN=MO Sub1', moRoot, { ca: true, ocspUrl: OCSP_URL });
  moSub2 = await issueCert('CN=MO Sub2', moSub1, { ca: true, ocspUrl: OCSP_URL });
  contract = await issueCert('CN=USEVTC123456789', moSub2, { ocspUrl: OCSP_URL });
});

/** The provider answers like the Test System responder: revoked for `revokedSerials`. */
function respondWith(revokedSerials: string[] = [], unreachable: string[] = []): void {
  const all = [contract, moSub2, moSub1];
  getOcspStatus.mockImplementation((data) => {
    if (unreachable.includes(data.serialNumber)) {
      return Promise.resolve({ status: 'Failed', ocspResult: '' });
    }
    const cert = all.find((c) => requestDataFor(c).serialNumber === data.serialNumber);
    if (cert?.issuer == null) return Promise.resolve({ status: 'Failed', ocspResult: '' });
    const der = buildResponse(buildOcspRequest(requestDataFor(cert)), {
      status: revokedSerials.includes(data.serialNumber) ? 'revoked' : 'good',
      signer: cert.issuer,
      includeCerts: [cert.issuer],
    });
    return Promise.resolve({ status: 'Accepted', ocspResult: der.toString('base64') });
  });
}

beforeEach(() => {
  caRows = [];
  localMo = null;
  localCertificateStatus.mockReset();
  localCertificateStatus.mockResolvedValue(null);
  clearContractValidationCaCache();
  getOcspStatus.mockReset();
});

describe('validateContractCertificate with iso15118CertificateHashData', () => {
  const hashData = () => [contract, moSub2, moSub1].map((c) => requestDataFor(c, OCSP_URL));

  it('is Accepted when every certificate is good', async () => {
    respondWith();
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('Accepted');
    expect(getOcspStatus).toHaveBeenCalledTimes(3);
  });

  it('is CertificateRevoked when the contract certificate is revoked', async () => {
    respondWith([requestDataFor(contract).serialNumber]);
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('CertificateRevoked');
  });

  it('is CertChainError when a responder cannot be reached', async () => {
    respondWith([], [requestDataFor(moSub1).serialNumber]);
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('CertChainError');
  });

  it('is CertChainError when a response is not signed by the issuer', async () => {
    const impostor = await issueCert('CN=Impostor', null, { ca: true });
    getOcspStatus.mockImplementation((data) => {
      const cert = [contract, moSub2, moSub1].find(
        (c) => requestDataFor(c).serialNumber === data.serialNumber,
      );
      if (cert == null) return Promise.resolve({ status: 'Failed', ocspResult: '' });
      const der = buildResponse(buildOcspRequest(requestDataFor(cert)), {
        status: 'good',
        signer: impostor,
        includeCerts: [impostor],
      });
      return Promise.resolve({ status: 'Accepted', ocspResult: der.toString('base64') });
    });
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('CertChainError');
  });
});

describe('validateContractCertificate with a PEM certificate chain', () => {
  const chainPem = () => [contract.pem, moSub2.pem, moSub1.pem].join('\n');

  it('is Accepted for a chain to a configured MO root with good OCSP status', async () => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    respondWith();
    expect(await validateContractCertificate({ certificate: chainPem() }, logger)).toBe('Accepted');
    expect(getOcspStatus).toHaveBeenCalledTimes(3);
    const urls = getOcspStatus.mock.calls.map(([d]) => d.responderURL);
    expect(urls).toEqual([OCSP_URL, OCSP_URL, OCSP_URL]);
  });

  it('is CertChainError when no configured root signed the chain', async () => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'CSMSRootCertificate' }];
    respondWith();
    expect(await validateContractCertificate({ certificate: chainPem() }, logger)).toBe(
      'CertChainError',
    );
    expect(getOcspStatus).not.toHaveBeenCalled();
  });

  it('is CertificateRevoked when OCSP reports a revoked SubCA', async () => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    respondWith([requestDataFor(moSub2).serialNumber]);
    expect(await validateContractCertificate({ certificate: chainPem() }, logger)).toBe(
      'CertificateRevoked',
    );
  });

  it('is CertificateExpired for an expired contract certificate', async () => {
    const expired = await issueCert('CN=Expired', moSub2, {
      ocspUrl: OCSP_URL,
      notBefore: new Date(Date.now() - 10 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
    });
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    expect(
      await validateContractCertificate(
        { certificate: [expired.pem, moSub2.pem, moSub1.pem].join('\n') },
        logger,
      ),
    ).toBe('CertificateExpired');
  });

  it('is CertChainError for a broken chain or unparsable PEM', async () => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    expect(
      await validateContractCertificate(
        { certificate: [contract.pem, moSub1.pem].join('\n') },
        logger,
      ),
    ).toBe('CertChainError');
    expect(await validateContractCertificate({ certificate: 'not a pem' }, logger)).toBe(
      'CertChainError',
    );
  });
});

describe('validateContractCertificate for the local contract CA', () => {
  it('answers hash data from the local records instead of OCSP', async () => {
    localCertificateStatus.mockResolvedValue('good');
    const hashData = [contract, moSub2].map((c) => requestDataFor(c, ''));
    expect(
      await validateContractCertificate({ iso15118CertificateHashData: hashData }, logger),
    ).toBe('Accepted');
    expect(getOcspStatus).not.toHaveBeenCalled();
    localCertificateStatus.mockResolvedValue('revoked');
    expect(
      await validateContractCertificate({ iso15118CertificateHashData: hashData }, logger),
    ).toBe('CertificateRevoked');
  });

  it('fails a certificate without a responder URL that the local CA did not issue', async () => {
    const hashData = [requestDataFor(contract, '')];
    expect(
      await validateContractCertificate({ iso15118CertificateHashData: hashData }, logger),
    ).toBe('CertChainError');
    expect(getOcspStatus).not.toHaveBeenCalled();
  });

  it('trusts the local MO root for a PEM chain without OCSP URLs', async () => {
    const root = await issueCert('CN=Local MO Root', null, { ca: true });
    const sub1 = await issueCert('CN=Local MO Sub1', root, { ca: true });
    const sub2 = await issueCert('CN=Local MO Sub2', sub1, { ca: true });
    const leaf = await issueCert('CN=USEVTC000000001', sub2);
    localMo = {
      roots: [root.asn],
      contractIssuers: [sub2.asn],
      all: [root.asn, sub1.asn, sub2.asn],
    };
    localCertificateStatus.mockResolvedValue('good');
    expect(
      await validateContractCertificate(
        { certificate: [leaf.pem, sub2.pem, sub1.pem].join('\n') },
        logger,
      ),
    ).toBe('Accepted');
    expect(localCertificateStatus).toHaveBeenCalledTimes(3);
    expect(getOcspStatus).not.toHaveBeenCalled();
  });
});

describe('applyContractCertificateVerdict', () => {
  it('follows C07.FR.13 to C07.FR.17', () => {
    expect(applyContractCertificateVerdict('Accepted', 'Accepted')).toEqual({
      status: 'Accepted',
      certificateStatus: 'Accepted',
    });
    expect(applyContractCertificateVerdict('ConcurrentTx', 'Accepted')).toEqual({
      status: 'ConcurrentTx',
      certificateStatus: 'Accepted',
    });
    for (const s of ['Blocked', 'Expired', 'Invalid', 'Unknown'] as const) {
      expect(applyContractCertificateVerdict(s, 'Accepted')).toEqual({
        status: s,
        certificateStatus: 'ContractCancelled',
      });
    }
    expect(applyContractCertificateVerdict('Accepted', 'CertificateRevoked')).toEqual({
      status: 'Invalid',
      certificateStatus: 'CertificateRevoked',
    });
    expect(applyContractCertificateVerdict('Accepted', 'CertificateExpired')).toEqual({
      status: 'Expired',
      certificateStatus: 'CertificateExpired',
    });
    expect(applyContractCertificateVerdict('Accepted', 'CertChainError')).toEqual({
      status: 'Invalid',
      certificateStatus: 'CertChainError',
    });
  });
});
