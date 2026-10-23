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
    }) => Promise<{ status: 'Accepted' | 'Failed'; ocspResult: string; reason?: string }>
  >();

vi.mock('../../../services/pki/provider-factory.js', () => ({
  getPkiProvider: () => Promise.resolve({ getOcspStatus }),
}));

// The local contract CA (none by default): its MO certificates and the
// status of certificates it issued.
let localMo: { roots: unknown[]; contractIssuers: unknown[]; all: unknown[] } | null = null;
const localCertificateStatus =
  vi.fn<(d: { serialNumber: string }, expectedToken?: string) => Promise<string | null>>();
const isLocalContractToken = vi.fn<(idToken: string) => Promise<boolean>>();
vi.mock('../../../services/pki/local-contract-status.js', () => ({
  getLocalMoCertificates: () => Promise.resolve(localMo),
  localCertificateStatus: (d: { serialNumber: string }, expectedToken?: string) =>
    localCertificateStatus(d, expectedToken),
  isLocalContractToken: (idToken: string) => isLocalContractToken(idToken),
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
// X.509 KeyUsageFlags.digitalSignature (@peculiar/x509).
const DIGITAL_SIGNATURE = 1;
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

/**
 * The provider answers like the Test System responder: revoked for
 * `revokedSerials`. Each response carries only its issuer, so the chain to the
 * known root runs through the issuers the other responses carry.
 */
function respondWith(revokedSerials: string[] = [], unreachable: string[] = []): void {
  const all = [contract, moSub2, moSub1];
  getOcspStatus.mockImplementation((data) => {
    if (unreachable.includes(data.serialNumber)) {
      return Promise.resolve({ status: 'Failed', ocspResult: '', reason: 'fetch failed' });
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
  isLocalContractToken.mockReset();
  isLocalContractToken.mockResolvedValue(false);
  clearContractValidationCaCache();
  getOcspStatus.mockReset();
});

describe('validateContractCertificate with iso15118CertificateHashData', () => {
  const hashData = () => [contract, moSub2, moSub1].map((c) => requestDataFor(c, OCSP_URL));

  it('is Accepted when every certificate is good', async () => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    respondWith();
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('Accepted');
    expect(getOcspStatus).toHaveBeenCalledTimes(3);
  });

  it('is CertChainError when no known CA anchors the issuers the responses carry', async () => {
    respondWith();
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('CertChainError');
  });

  it('is CertificateRevoked when the contract certificate is revoked', async () => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    respondWith([requestDataFor(contract).serialNumber]);
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('CertificateRevoked');
  });

  it('is CertChainError when a responder cannot be reached', async () => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    respondWith([], [requestDataFor(moSub1).serialNumber]);
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData() },
      logger,
    );
    expect(verdict).toBe('CertChainError');
    // The station named the responder: a warning, with the reason, not an error.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      {
        serialNumber: requestDataFor(moSub1).serialNumber,
        responderURL: requestDataFor(moSub1).responderURL,
        reason: 'fetch failed',
      },
      'Contract certificate OCSP status request failed',
    );
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
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

describe('contract chain CA rules', () => {
  // Every certificate reads good, so the CA rules alone decide the verdict.
  beforeEach(() => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    localCertificateStatus.mockResolvedValue('good');
  });

  it('refuses a leaf signed by a valid contract certificate', async () => {
    const forged = await issueCert('CN=USEVTC999999999', contract, { ocspUrl: OCSP_URL });
    const pem = [forged.pem, contract.pem, moSub2.pem, moSub1.pem].join('\n');
    expect(await validateContractCertificate({ certificate: pem }, logger)).toBe('CertChainError');
    expect(localCertificateStatus).not.toHaveBeenCalled();
  });

  it('refuses the trusted root alone', async () => {
    expect(await validateContractCertificate({ certificate: moRoot.pem }, logger)).toBe(
      'CertChainError',
    );
  });

  it('refuses the local MO root PEM alone with a local CA configured', async () => {
    caRows = [];
    const root = await issueCert('CN=Local MO Root', null, { ca: true });
    localMo = { roots: [root.asn], contractIssuers: [], all: [root.asn] };
    localCertificateStatus.mockResolvedValue('good');
    expect(await validateContractCertificate({ certificate: root.pem }, logger)).toBe(
      'CertChainError',
    );
  });

  it('refuses a chain longer than 4 certificates', async () => {
    const s3 = await issueCert('CN=MO Sub3', moSub2, { ca: true, ocspUrl: OCSP_URL });
    const s4 = await issueCert('CN=MO Sub4', s3, { ca: true, ocspUrl: OCSP_URL });
    const leaf = await issueCert('CN=USEVTC123456780', s4, { ocspUrl: OCSP_URL });
    const pem = [leaf.pem, s4.pem, s3.pem, moSub2.pem, moSub1.pem].join('\n');
    expect(await validateContractCertificate({ certificate: pem }, logger)).toBe('CertChainError');
  });

  it('refuses an intermediate without keyCertSign', async () => {
    const sub2 = await issueCert('CN=MO Sub2 No Sign', moSub1, {
      ca: true,
      ocspUrl: OCSP_URL,
      keyUsage: DIGITAL_SIGNATURE,
    });
    const leaf = await issueCert('CN=USEVTC123456781', sub2, { ocspUrl: OCSP_URL });
    const pem = [leaf.pem, sub2.pem, moSub1.pem].join('\n');
    expect(await validateContractCertificate({ certificate: pem }, logger)).toBe('CertChainError');
  });

  it('refuses a chain that exceeds an issuer pathLen', async () => {
    const sub1 = await issueCert('CN=MO Sub1 Len0', moRoot, {
      ca: true,
      ocspUrl: OCSP_URL,
      pathLength: 0,
    });
    const sub2 = await issueCert('CN=MO Sub2 Len', sub1, { ca: true, ocspUrl: OCSP_URL });
    const leaf = await issueCert('CN=USEVTC123456782', sub2, { ocspUrl: OCSP_URL });
    const pem = [leaf.pem, sub2.pem, sub1.pem].join('\n');
    expect(await validateContractCertificate({ certificate: pem }, logger)).toBe('CertChainError');
  });

  it('accepts a valid chain that also carries the root', async () => {
    const pem = [contract.pem, moSub2.pem, moSub1.pem, moRoot.pem].join('\n');
    expect(await validateContractCertificate({ certificate: pem }, logger)).toBe('Accepted');
  });
});

describe('eMAID binding', () => {
  const chainPem = () => [contract.pem, moSub2.pem, moSub1.pem].join('\n');

  beforeEach(() => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    respondWith();
  });

  it('accepts the eMAID of the leaf, with separators and the check digit', async () => {
    for (const idToken of ['USEVTC123456789', 'US-EVT-C12345678-9', 'usevtc12345678']) {
      expect(
        await validateContractCertificate(
          { certificate: chainPem(), idToken: { idToken, type: 'eMAID' } },
          logger,
        ),
      ).toBe('Accepted');
    }
  });

  it('refuses another contract eMAID with a valid chain', async () => {
    expect(
      await validateContractCertificate(
        { certificate: chainPem(), idToken: { idToken: 'USEVTC000000017', type: 'eMAID' } },
        logger,
      ),
    ).toBe('CertChainError');
    expect(applyContractCertificateVerdict('Accepted', 'CertChainError').status).toBe('Invalid');
  });

  it('passes the idToken to the local records for hash data', async () => {
    localCertificateStatus.mockResolvedValue('mismatch');
    const hashData = [contract, moSub2].map((c) => requestDataFor(c, ''));
    expect(
      await validateContractCertificate(
        {
          iso15118CertificateHashData: hashData,
          idToken: { idToken: 'USEVTC000000017', type: 'eMAID' },
        },
        logger,
      ),
    ).toBe('CertChainError');
    expect(localCertificateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serialNumber: hashData[0]?.serialNumber }),
      'USEVTC000000017',
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

  it('answers CertificateExpired for an expired local contract certificate (C07.FR.15)', async () => {
    localCertificateStatus.mockResolvedValueOnce('expired').mockResolvedValue('good');
    const hashData = [contract, moSub2].map((c) => requestDataFor(c, ''));
    const verdict = await validateContractCertificate(
      { iso15118CertificateHashData: hashData },
      logger,
    );
    expect(verdict).toBe('CertificateExpired');
    expect(applyContractCertificateVerdict('Accepted', verdict)).toEqual({
      status: 'Expired',
      certificateStatus: 'CertificateExpired',
    });
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

// Hash data names no leaf the CSMS can
// read, so a list of local sub-CAs only, or a foreign leaf for a local
// contract token, must not pass as the idToken's contract certificate.
describe('hash data binding to the idToken', () => {
  let localRoot: TestCert;
  let localSub1: TestCert;
  let localSub2: TestCert;
  let localLeaf: TestCert;
  const emaid = { idToken: 'USEVTC000000001', type: 'eMAID' };

  beforeAll(async () => {
    localRoot = await issueCert('CN=Local MO Root', null, { ca: true });
    localSub1 = await issueCert('CN=Local MO Sub1', localRoot, { ca: true });
    localSub2 = await issueCert('CN=Local MO Sub2', localSub1, { ca: true });
    localLeaf = await issueCert('CN=USEVTC000000001', localSub2);
  });

  beforeEach(() => {
    localMo = {
      roots: [localRoot.asn],
      contractIssuers: [localSub2.asn],
      all: [localRoot.asn, localSub1.asn, localSub2.asn],
    };
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
    respondWith();
    localCertificateStatus.mockImplementation((d) =>
      Promise.resolve(
        [localSub2, localSub1].some((c) => requestDataFor(c).serialNumber === d.serialNumber)
          ? 'good'
          : requestDataFor(localLeaf).serialNumber === d.serialNumber
            ? 'good'
            : null,
      ),
    );
  });

  it('answers CertChainError for hash data with only local sub-CA entries', async () => {
    const hashData = [localSub2, localSub1].map((c) => requestDataFor(c, ''));
    expect(
      await validateContractCertificate(
        { iso15118CertificateHashData: hashData, idToken: emaid },
        logger,
      ),
    ).toBe('CertChainError');
    expect(
      await validateContractCertificate({ iso15118CertificateHashData: hashData }, logger),
    ).toBe('CertChainError');
  });

  it('answers CertChainError for a local contract eMAID with a good foreign-issuer leaf', async () => {
    isLocalContractToken.mockResolvedValue(true);
    const hashData = [contract, moSub2, moSub1].map((c) => requestDataFor(c, OCSP_URL));
    expect(
      await validateContractCertificate(
        { iso15118CertificateHashData: hashData, idToken: emaid },
        logger,
      ),
    ).toBe('CertChainError');
    expect(getOcspStatus).not.toHaveBeenCalled();
    expect(isLocalContractToken).toHaveBeenCalledWith('USEVTC000000001');
  });

  it('accepts the same foreign chain for an eMAID that is no local contract', async () => {
    const hashData = [contract, moSub2, moSub1].map((c) => requestDataFor(c, OCSP_URL));
    expect(
      await validateContractCertificate(
        {
          iso15118CertificateHashData: hashData,
          idToken: { idToken: 'USEVTC123456789', type: 'eMAID' },
        },
        logger,
      ),
    ).toBe('Accepted');
  });

  it('accepts a local contract eMAID whose hash data names its local leaf', async () => {
    isLocalContractToken.mockResolvedValue(true);
    const hashData = [localLeaf, localSub2, localSub1].map((c) => requestDataFor(c, ''));
    expect(
      await validateContractCertificate(
        { iso15118CertificateHashData: hashData, idToken: emaid },
        logger,
      ),
    ).toBe('Accepted');
  });
});

// A contract certificate names an eMAID,
// so it never counts as accepted for an idToken of another type. A revoked or
// expired chain still answers its status (OCTT TC_C_51_CSMS sends ISO14443).
describe('contract certificates for an idToken that is no eMAID', () => {
  const chainPem = () => [contract.pem, moSub2.pem, moSub1.pem].join('\n');
  const hashData = () => [contract, moSub2, moSub1].map((c) => requestDataFor(c, OCSP_URL));

  beforeEach(() => {
    caRows = [{ certificate: moRoot.pem, certificateType: 'MORootCertificate' }];
  });

  it('refuses a valid chain for an ISO14443 or Central idToken', async () => {
    respondWith();
    for (const type of ['ISO14443', 'Central', 'KeyCode']) {
      const idToken = { idToken: 'USEVTC123456789', type };
      expect(await validateContractCertificate({ certificate: chainPem(), idToken }, logger)).toBe(
        'CertChainError',
      );
      expect(
        await validateContractCertificate(
          { iso15118CertificateHashData: hashData(), idToken },
          logger,
        ),
      ).toBe('CertChainError');
    }
  });

  it('still answers CertificateRevoked for a revoked chain', async () => {
    respondWith([requestDataFor(contract).serialNumber]);
    expect(
      await validateContractCertificate(
        {
          iso15118CertificateHashData: hashData(),
          idToken: { idToken: '0A1B2C3D', type: 'ISO14443' },
        },
        logger,
      ),
    ).toBe('CertificateRevoked');
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
