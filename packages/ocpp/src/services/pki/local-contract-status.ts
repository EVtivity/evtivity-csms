// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Revocation status of certificates the local contract CA issued. They carry
// no OCSP responder: the CSMS knows their status from its own records, so
// contract certificate authorization (C07) answers them here instead of over
// OCSP. A contract certificate is good while its contract is active and the
// certificate is within its validity period, expired after it (C07.FR.15),
// revoked once the contract is revoked, and unknown when the CA has no record
// of it.

import { client } from '@evtivity/database';
import type { Certificate } from '@peculiar/asn1-x509';
import { getLocalContractCa } from './local-ca-store.js';
import type { LocalContractCa } from './local-contract-ca.js';
import { normalizeEmaid, sameEmaid } from './emaid.js';
import {
  isIssuerOf,
  normalizeSerialHex,
  parseCertificate,
  type OcspCertId,
  type OcspCertStatus,
} from './ocsp.js';

/**
 * Status of a local CA certificate: an OCSP status, expired for a contract
 * certificate, or mismatch for a contract certificate of another contract
 * than the expected eMAID token.
 */
export type LocalCertStatus = OcspCertStatus | 'expired' | 'mismatch';

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
 *
 * `expectedToken` binds a contract certificate to the token being authorized
 * (C07 hash data, where the CSMS cannot read the leaf): the certificate must
 * belong to the contract of that eMAID token, else `mismatch`. Undefined skips
 * the binding (GetCertificateChainStatus, and the PEM chain, which compares
 * the leaf CN itself).
 */
export async function localCertificateStatus(
  certId: OcspCertId,
  expectedToken?: string,
): Promise<LocalCertStatus | null> {
  const local = await getLocalMoCertificates();
  if (local == null) return null;
  const serial = normalizeSerialHex(certId.serialNumber);
  if (local.contractIssuers.some((issuer) => isIssuerOf(issuer, certId))) {
    const rows = await client`
      SELECT c.status, cc.valid_to, dt.id_token
      FROM pnc_contract_certificates cc
      JOIN pnc_contracts c ON c.id = cc.contract_id
      JOIN driver_tokens dt ON dt.id = c.driver_token_id
      WHERE cc.serial_number = ${serial}
      LIMIT 1
    `;
    const row = rows[0];
    if (row == null) return 'unknown';
    if (expectedToken !== undefined && !sameEmaid(String(row.id_token ?? ''), expectedToken)) {
      return 'mismatch';
    }
    if (row.status === 'revoked') return 'revoked';
    return new Date(row.valid_to as Date | string).getTime() > Date.now() ? 'good' : 'expired';
  }
  const issuer = local.all.find((ca) => isIssuerOf(ca, certId));
  if (issuer == null) return null;
  // A local sub-CA: good when the serial is one the local CA issued.
  return local.all.some((ca) => serialOf(ca) === serial) ? 'good' : 'unknown';
}

/**
 * True when the idToken is the eMAID of a contract of the local contract CA
 * (`pnc_contracts`, any status). Its contract certificate is then a local one,
 * so hash data without a local contract certificate cannot stand for it.
 */
export async function isLocalContractToken(idToken: string): Promise<boolean> {
  const normalized = normalizeEmaid(idToken);
  if (normalized === '') return false;
  const rows = await client`
    SELECT dt.id_token
    FROM pnc_contracts c
    JOIN driver_tokens dt ON dt.id = c.driver_token_id
    WHERE left(upper(translate(dt.id_token, '-*', '')), 14) = ${normalized.slice(0, 14)}
  `;
  return rows.some((row) => sameEmaid(String(row.id_token ?? ''), idToken));
}
