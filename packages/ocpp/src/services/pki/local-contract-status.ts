// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Revocation status of certificates the local contract CA issued. They carry
// no OCSP responder: the CSMS knows their status from its own records, so
// contract certificate authorization (C07) answers them here instead of over
// OCSP. A contract certificate is good while its contract is active and the
// certificate is within its validity period, revoked once the contract is
// revoked, and unknown when the CA has no record of it.

import { client } from '@evtivity/database';
import type { Certificate } from '@peculiar/asn1-x509';
import { getLocalContractCa } from './local-ca-store.js';
import type { LocalContractCa } from './local-contract-ca.js';
import {
  isIssuerOf,
  normalizeSerialHex,
  parseCertificate,
  type OcspCertId,
  type OcspCertStatus,
} from './ocsp.js';

export interface LocalMoCertificates {
  /** MO roots of both hierarchies, the trust anchors of local contracts. */
  roots: Certificate[];
  /** MO Sub-CA 2 of both hierarchies, the issuers of contract certificates. */
  contractIssuers: Certificate[];
  /** Every MO CA certificate. */
  all: Certificate[];
}

let parsed: { source: LocalContractCa; certs: LocalMoCertificates } | null = null;

/** The local MO CA certificates, or null when no local contract CA exists. */
export async function getLocalMoCertificates(): Promise<LocalMoCertificates | null> {
  const ca = await getLocalContractCa();
  if (ca == null) return null;
  if (parsed?.source === ca) return parsed.certs;
  const hierarchies = [ca.iso2, ca.iso20];
  const roots = hierarchies.map((h) => parseCertificate(h.moRoot.cert));
  const subCa1 = hierarchies.map((h) => parseCertificate(h.moSubCa1.cert));
  const contractIssuers = hierarchies.map((h) => parseCertificate(h.moSubCa2.cert));
  const certs = { roots, contractIssuers, all: [...roots, ...subCa1, ...contractIssuers] };
  parsed = { source: ca, certs };
  return certs;
}

function serialOf(cert: Certificate): string {
  return normalizeSerialHex(Buffer.from(cert.tbsCertificate.serialNumber).toString('hex'));
}

/**
 * Status of the certificate a CertID names when a local MO CA issued it;
 * null when the issuer is not part of the local contract CA.
 */
export async function localCertificateStatus(certId: OcspCertId): Promise<OcspCertStatus | null> {
  const local = await getLocalMoCertificates();
  if (local == null) return null;
  const serial = normalizeSerialHex(certId.serialNumber);
  if (local.contractIssuers.some((issuer) => isIssuerOf(issuer, certId))) {
    const rows = await client`
      SELECT c.status, cc.valid_to
      FROM pnc_contract_certificates cc
      JOIN pnc_contracts c ON c.id = cc.contract_id
      WHERE cc.serial_number = ${serial}
      LIMIT 1
    `;
    const row = rows[0];
    if (row == null) return 'unknown';
    if (row.status === 'revoked') return 'revoked';
    return new Date(row.valid_to as Date | string).getTime() > Date.now() ? 'good' : 'unknown';
  }
  const issuer = local.all.find((ca) => isIssuerOf(ca, certId));
  if (issuer == null) return null;
  // A local sub-CA: good when the serial is one the local CA issued.
  return local.all.some((ca) => serialOf(ca) === serial) ? 'good' : 'unknown';
}
