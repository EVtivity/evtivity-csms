// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Real test certificates for the cases that send or report a certificate or its
// hash data. Every certificate and key is generated per test run; nothing is
// committed.

import {
  certificateHashDataOf,
  createRootCertificate,
  issueCertificate,
  type CertificateHashData,
  type HashAlgorithm,
  type TestCertificate,
} from './cs-security-pki.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A self-signed root CA and its hash data (a root is its own issuer). */
export async function testRootCertificate(
  commonName: string,
  hashAlgorithm: HashAlgorithm = 'SHA256',
): Promise<{ root: TestCertificate; hashData: CertificateHashData }> {
  const root = await createRootCertificate(commonName);
  return { root, hashData: certificateHashDataOf(root.cert, root.cert, hashAlgorithm) };
}

/** A self-signed root CA whose validity ended yesterday. */
export function expiredRootCertificate(commonName: string): Promise<TestCertificate> {
  return issueCertificate({
    subject: `CN=${commonName},O=OCTT,C=US`,
    issuer: null,
    ca: true,
    notBefore: new Date(Date.now() - 30 * DAY_MS),
    notAfter: new Date(Date.now() - DAY_MS),
  });
}

/** Hash data of a leaf certificate with `subject` issued by a new test root `rootName`. */
export async function leafCertificateHashData(
  subject: string,
  rootName: string,
): Promise<CertificateHashData> {
  const root = await createRootCertificate(rootName);
  const leaf = await issueCertificate({ subject, issuer: root });
  return certificateHashDataOf(leaf.cert, root.cert);
}

/** Hash data of a contract certificate issued by a test MO root (ISO 15118 eMAID as CN). */
export function contractCertificateHashData(): Promise<CertificateHashData> {
  return leafCertificateHashData('CN=USOCTC1234567890,O=OCTT,C=US', 'OCTT MO Root CA');
}

/**
 * Hash data of an installed certificate of `certificateType`: a root for the
 * root certificate types, a leaf issued by a V2G root for V2GCertificateChain.
 */
export async function installedCertificateHashData(
  certificateType: string,
  hashAlgorithm: HashAlgorithm = 'SHA256',
): Promise<CertificateHashData> {
  if (certificateType === 'V2GCertificateChain') {
    return leafCertificateHashData('CN=OCTT SECC,O=OCTT,C=US', 'OCTT V2G Root CA');
  }
  return (await testRootCertificate(`OCTT ${certificateType}`, hashAlgorithm)).hashData;
}
