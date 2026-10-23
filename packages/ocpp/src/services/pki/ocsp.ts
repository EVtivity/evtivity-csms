// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCSP (IETF RFC 6960) for OCPP 2.1 M06 GetCertificateStatus and C07
// contract certificate authorization: builds the DER OCSPRequest from OCPP
// OCSPRequestDataType, posts it to the responder, and parses and verifies the
// DER OCSPResponse.

import crypto from 'node:crypto';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  AlgorithmIdentifier,
  BasicConstraints,
  Certificate,
  ExtendedKeyUsage,
  KeyUsage,
  KeyUsageFlags,
  id_ce_basicConstraints,
  id_ce_extKeyUsage,
  id_ce_keyUsage,
} from '@peculiar/asn1-x509';
import {
  BasicOCSPResponse,
  CertID,
  OCSPRequest,
  OCSPResponse,
  OCSPResponseStatus,
  Request,
  TBSRequest,
  id_kp_OCSPSigning,
  id_pkix_ocsp_basic,
} from '@peculiar/asn1-ocsp';
import { blockedDestinationOf, isPrivateUrl, readCappedBody, safeFetch } from '@evtivity/lib';
import type { SafeFetchResponse } from '@evtivity/lib';
import { getOcspAllowedPrivateHosts } from '@evtivity/database';
import type { OcspRequestData, OcspResult } from './pki-provider.js';

/** OCPP HashAlgorithmEnumType. */
export type OcspHashAlgorithm = 'SHA256' | 'SHA384' | 'SHA512';

/** The CertID fields of OCPP OCSPRequestDataType (hex strings). */
export interface OcspCertId {
  hashAlgorithm: string;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

export type OcspCertStatus = 'good' | 'revoked' | 'unknown';

export class OcspError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OcspError';
  }
}

const HASH_OIDS: Record<OcspHashAlgorithm, string> = {
  SHA256: '2.16.840.1.101.3.4.2.1',
  SHA384: '2.16.840.1.101.3.4.2.2',
  SHA512: '2.16.840.1.101.3.4.2.3',
};

const NODE_HASH: Record<OcspHashAlgorithm, string> = {
  SHA256: 'sha256',
  SHA384: 'sha384',
  SHA512: 'sha512',
};

// Signature algorithms accepted on an OCSP response (RFC 5758, RFC 4055).
const SIGNATURE_HASH_BY_OID: Record<string, string> = {
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
};

// Responder and CSMS clocks drift; RFC 6960 leaves the tolerance to the client.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * Oldest thisUpdate accepted from a response without nextUpdate:
 * RFC 6960 lets a responder leave it out ("newer information is always
 * available"), which would otherwise accept a replayed response of any age.
 */
export const OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_MS = 7 * 24 * 60 * 60 * 1000;

// OCSP responders can hang under load or attack. Without a timeout the OCPP
// handler that started the check blocks until the station's call times out.
export const OCSP_TIMEOUT_MS = 15_000;

// Upper bound on a responder body read into memory.
const MAX_RESPONSE_BYTES = 64 * 1024;

// GetCertificateStatusResponse.ocspResult maxLength (base64 characters).
const MAX_OCSP_RESULT_LENGTH = 18_000;

const HEX = /^[0-9a-fA-F]+$/;

function hexToBytes(value: string, field: string): Buffer {
  if (value.length === 0 || value.length % 2 !== 0 || !HEX.test(value)) {
    throw new OcspError(`${field} is not an even-length hex string`);
  }
  return Buffer.from(value, 'hex');
}

/** Serial number as lowercase hex without leading zeroes ("0" for zero). */
export function normalizeSerialHex(value: string): string {
  const stripped = value.toLowerCase().replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** DER INTEGER content octets of a positive serial number given as hex. */
function serialToIntegerBytes(serialHex: string): ArrayBuffer {
  if (serialHex.length === 0 || !HEX.test(serialHex)) {
    throw new OcspError('serialNumber is not a hex string');
  }
  const normalized = normalizeSerialHex(serialHex);
  const padded = normalized.length % 2 === 0 ? normalized : `0${normalized}`;
  let bytes = Buffer.from(padded, 'hex');
  // A set high bit would make the INTEGER negative: prepend a zero octet.
  if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return new Uint8Array(bytes).buffer;
}

function hashAlgorithmOf(value: string): OcspHashAlgorithm {
  if (value === 'SHA256' || value === 'SHA384' || value === 'SHA512') return value;
  throw new OcspError(`Unsupported hashAlgorithm ${value}`);
}

function toCertId(data: OcspCertId): CertID {
  const algorithm = hashAlgorithmOf(data.hashAlgorithm);
  return new CertID({
    // RFC 5754: the parameters of a SHA-2 AlgorithmIdentifier are absent.
    hashAlgorithm: new AlgorithmIdentifier({ algorithm: HASH_OIDS[algorithm] }),
    issuerNameHash: new OctetString(hexToBytes(data.issuerNameHash, 'issuerNameHash')),
    issuerKeyHash: new OctetString(hexToBytes(data.issuerKeyHash, 'issuerKeyHash')),
    serialNumber: serialToIntegerBytes(data.serialNumber),
  });
}

/** DER-encoded OCSPRequest (RFC 6960 4.1.1) for one certificate, unsigned, no nonce. */
export function buildOcspRequest(data: OcspCertId): Buffer {
  const request = new OCSPRequest({
    tbsRequest: new TBSRequest({ requestList: [new Request({ reqCert: toCertId(data) })] }),
  });
  return Buffer.from(AsnConvert.serialize(request));
}

/**
 * Whether the CSMS may send an OCSP request to this URL, judged from the URL
 * alone. Public http(s) URLs pass. A private or internal IP literal or name
 * passes only when its host is in the operator allowlist
 * (`pnc.ocsp.allowedPrivateHosts`): the responder URL comes from the station
 * or its certificate, so without the guard the CSMS is an SSRF probe. What a
 * name resolves to is checked when postOcspRequest connects.
 */
export function isOcspResponderAllowed(url: string, allowedPrivateHosts: string[]): boolean {
  const parsed = URL.parse(url);
  if (parsed == null) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!isPrivateUrl(url)) return true;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return allowedPrivateHosts.includes(host);
}

/**
 * POSTs a DER OCSPRequest to the responder (RFC 6960 Appendix A.1) and
 * returns the DER OCSPResponse body. The request goes through safeFetch: every
 * address the responder host resolves to must be public unless the host is in
 * `allowedPrivateHosts`, and the connection uses the checked address, so a DNS
 * rebinding cannot reach an internal service. Throws OcspError on a blocked
 * address, network error, timeout, redirect, non-2xx status, or oversized
 * body. The caller checks the URL with isOcspResponderAllowed first.
 */
export async function postOcspRequest(
  responderURL: string,
  requestDer: Buffer,
  allowedPrivateHosts: readonly string[] = [],
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, OCSP_TIMEOUT_MS);
  try {
    let response: SafeFetchResponse;
    try {
      response = await safeFetch(responderURL, {
        allowedPrivateHosts,
        method: 'POST',
        headers: {
          'Content-Type': 'application/ocsp-request',
          Accept: 'application/ocsp-response',
        },
        body: new Uint8Array(requestDer),
        // A redirect could point the request at an address the guard rejects.
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      const blocked = blockedDestinationOf(err);
      if (blocked != null) {
        throw new OcspError(
          `Responder host ${blocked.host} resolves to private address ${blocked.address}, not in pnc.ocsp.allowedPrivateHosts`,
        );
      }
      throw new OcspError(
        `OCSP request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new OcspError(`OCSP responder returned HTTP ${String(response.status)}`);
    }
    // Read as a stream and cut off at the cap: a responder that streams
    // without end cannot make the process buffer it.
    let body: Buffer;
    try {
      body = await readCappedBody(response, MAX_RESPONSE_BYTES);
    } catch (err) {
      throw new OcspError(
        `OCSP response unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (body.length === 0) throw new OcspError('OCSP response is empty');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Parses a DER OCSPResponse. Throws OcspError when it is not one. */
export function parseOcspResponse(der: Buffer): OCSPResponse {
  try {
    return AsnConvert.parse(der, OCSPResponse);
  } catch (err) {
    throw new OcspError('Responder did not return a DER OCSPResponse', { cause: err });
  }
}

function hashHex(algorithm: string, data: ArrayBuffer | Buffer): string {
  return crypto
    .createHash(algorithm)
    .update(Buffer.from(data as ArrayBuffer))
    .digest('hex');
}

function spkiKeyBytes(cert: Certificate): ArrayBuffer {
  return cert.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey;
}

function nodeCertificate(cert: Certificate): crypto.X509Certificate {
  return new crypto.X509Certificate(Buffer.from(AsnConvert.serialize(cert)));
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function isWithinValidity(cert: Certificate, now: number): boolean {
  const validity = cert.tbsCertificate.validity;
  return (
    validity.notBefore.getTime().getTime() - CLOCK_SKEW_MS <= now &&
    now <= validity.notAfter.getTime().getTime() + CLOCK_SKEW_MS
  );
}

function hasOcspSigningEku(cert: Certificate): boolean {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_extKeyUsage);
  if (ext == null) return false;
  const eku = AsnConvert.parse(ext.extnValue, ExtendedKeyUsage);
  return eku.includes(id_kp_OCSPSigning);
}

function matchesResponderId(basic: BasicOCSPResponse, cert: Certificate): boolean {
  const id = basic.tbsResponseData.responderID;
  if (id.byKey != null) {
    return hashHex('sha1', spkiKeyBytes(cert)) === Buffer.from(id.byKey.buffer).toString('hex');
  }
  if (id.byName != null) {
    return sameBytes(
      AsnConvert.serialize(id.byName),
      AsnConvert.serialize(cert.tbsCertificate.subject),
    );
  }
  return false;
}

/**
 * The certificates a DER OCSPResponse carries (BasicOCSPResponse `certs`), or
 * none when it does not parse. Used as intermediates for the other responses
 * of one chain, never as trust anchors.
 */
export function ocspResponseCerts(der: Buffer): Certificate[] {
  try {
    const response = parseOcspResponse(der);
    if (response.responseBytes?.responseType !== id_pkix_ocsp_basic) return [];
    const certs =
      AsnConvert.parse(response.responseBytes.response.buffer, BasicOCSPResponse).certs ?? [];
    // A response over the cap is refused by its own verify and lends nothing.
    return certs.length > MAX_OCSP_CARRIED_CERTS ? [] : certs;
  } catch {
    // fail-open: an unreadable response adds no intermediates; its own verify refuses it
    return [];
  }
}

/** Parses a PEM or DER X.509 certificate. */
export function parseCertificate(pemOrDer: string | Buffer): Certificate {
  const der =
    typeof pemOrDer === 'string'
      ? Buffer.from(
          pemOrDer
            .replace(/-----BEGIN CERTIFICATE-----/, '')
            .replace(/-----END CERTIFICATE-----/, '')
            .replace(/\s+/g, ''),
          'base64',
        )
      : pemOrDer;
  return AsnConvert.parse(der, Certificate);
}

/**
 * OCSP CertID of `cert` issued by `issuer` (RFC 6960 4.1.1): issuerNameHash
 * is the hash of the issuer's DER subject name, issuerKeyHash the hash of the
 * issuer's subjectPublicKey bits.
 */
export function certIdFor(
  cert: Certificate,
  issuer: Certificate,
  hashAlgorithm: OcspHashAlgorithm,
): OcspCertId {
  const alg = NODE_HASH[hashAlgorithm];
  return {
    hashAlgorithm,
    issuerNameHash: hashHex(alg, AsnConvert.serialize(issuer.tbsCertificate.subject)),
    issuerKeyHash: hashHex(alg, spkiKeyBytes(issuer)),
    serialNumber: normalizeSerialHex(Buffer.from(cert.tbsCertificate.serialNumber).toString('hex')),
  };
}

/** Whether `issuer` is the CA that the CertID names (name and key hash). */
export function isIssuerOf(issuer: Certificate, certId: OcspCertId): boolean {
  const alg = NODE_HASH[hashAlgorithmOf(certId.hashAlgorithm)];
  return (
    hashHex(alg, spkiKeyBytes(issuer)) === certId.issuerKeyHash.toLowerCase() &&
    hashHex(alg, AsnConvert.serialize(issuer.tbsCertificate.subject)) ===
      certId.issuerNameHash.toLowerCase()
  );
}

function verifySignature(
  signatureAlgorithm: AlgorithmIdentifier,
  data: ArrayBuffer,
  signature: ArrayBuffer,
  signer: Certificate,
): boolean {
  const hash = SIGNATURE_HASH_BY_OID[signatureAlgorithm.algorithm];
  if (hash == null) return false;
  try {
    return crypto.verify(
      hash,
      Buffer.from(data),
      nodeCertificate(signer).publicKey,
      Buffer.from(signature),
    );
  } catch {
    // fail-open: a signature that cannot be checked counts as invalid, so the response is refused
    return false;
  }
}

/** Longest CA path from a carried issuer up to a known CA certificate. */
const MAX_CARRIED_CHAIN_DEPTH = 4;
/** Most certificates one OCSP response may carry; more refuse the response. */
export const MAX_OCSP_CARRIED_CERTS = 8;
/** Most signature checks one carried-issuer chain search may run (fail closed past it). */
export const MAX_CHAIN_SIGNATURE_CHECKS = 32;

/**
 * An issuer in a CA path (RFC 5280 6.1.4): cA, keyUsage with keyCertSign
 * (4.2.1.3, 4.2.1.9), and a pathLenConstraint that allows the `caBelow` CA
 * certificates under it (4.2.1.9). Shared by the PEM contract chain check and
 * the OCSP carried-issuer chain.
 */
export function canIssueCertificates(cert: Certificate, caBelow: number): boolean {
  const bcExt = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_basicConstraints);
  if (bcExt == null) return false;
  const bc = AsnConvert.parse(bcExt.extnValue, BasicConstraints);
  if (!bc.cA) return false;
  if (bc.pathLenConstraint != null && caBelow > bc.pathLenConstraint) return false;
  const ku = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_keyUsage);
  if (ku == null) return false;
  return (AsnConvert.parse(ku.extnValue, KeyUsage).toNumber() & KeyUsageFlags.keyCertSign) !== 0;
}

function certificateKey(cert: Certificate): string {
  return Buffer.from(AsnConvert.serialize(cert)).toString('base64');
}

/**
 * Whether `issuer`, a certificate the OCSP response carries, chains to one of
 * the `known` CA certificates: each step a CA signed by the next, within its
 * validity, under every pathLenConstraint above it, through the carried
 * certificates. A response cannot vouch for an issuer of its own making.
 * The search is bounded: each certificate is tried as a parent
 * once, the path has at most MAX_CARRIED_CHAIN_DEPTH steps, and past
 * MAX_CHAIN_SIGNATURE_CHECKS signature checks the issuer is refused.
 */
function chainsToKnownCa(
  issuer: Certificate,
  carried: Certificate[],
  known: Certificate[],
  now: number,
): boolean {
  const knownKeys = new Set(known.map(certificateKey));
  const visited = new Set<string>([certificateKey(issuer)]);
  let signatureChecks = 0;
  const pool = [...known, ...carried];

  // `caBelow`: the CA certificates under `cert` in the path (0 for the issuer).
  const search = (cert: Certificate, caBelow: number): boolean => {
    // A known CA anchors only within its validity.
    if (knownKeys.has(certificateKey(cert))) return isWithinValidity(cert, now);
    if (caBelow >= MAX_CARRIED_CHAIN_DEPTH) return false;
    if (!canIssueCertificates(cert, caBelow) || !isWithinValidity(cert, now)) return false;
    const issuerName = AsnConvert.serialize(cert.tbsCertificate.issuer);
    for (const parent of pool) {
      const key = certificateKey(parent);
      if (visited.has(key)) continue;
      if (!sameBytes(issuerName, AsnConvert.serialize(parent.tbsCertificate.subject))) continue;
      if (!canIssueCertificates(parent, caBelow + 1)) continue;
      if (signatureChecks >= MAX_CHAIN_SIGNATURE_CHECKS) return false;
      signatureChecks++;
      if (
        !verifySignature(
          cert.signatureAlgorithm,
          AsnConvert.serialize(cert.tbsCertificate),
          cert.signatureValue,
          parent,
        )
      ) {
        continue;
      }
      visited.add(key);
      if (search(parent, caBelow + 1)) return true;
      if (signatureChecks >= MAX_CHAIN_SIGNATURE_CHECKS) return false;
    }
    return false;
  };
  return search(issuer, 0);
}

/**
 * Verifies a DER OCSPResponse for one CertID and returns the certificate's
 * status. The issuer is identified by the CertID hashes, taken from
 * `knownIssuers` (operator CA certificates and local CAs) or from the
 * certificates the response (or `intermediates`, certificates other responses
 * of the same chain carried) carries; a carried issuer counts only through a
 * CA chain to a known one, and `intermediates` never anchor one. The response must be signed by the
 * issuer or by a responder certificate the issuer signed for OCSP signing
 * (RFC 6960 4.2.2.2), and must be current. Throws OcspError when it cannot be
 * verified.
 */
export function verifyOcspResponse(
  der: Buffer,
  certId: OcspCertId,
  knownIssuers: Certificate[],
  now: number = Date.now(),
  intermediates: Certificate[] = [],
): OcspCertStatus {
  const response = parseOcspResponse(der);
  if (response.responseStatus !== OCSPResponseStatus.successful) {
    throw new OcspError(
      `OCSP responder returned status ${OCSPResponseStatus[response.responseStatus]}`,
    );
  }
  if (response.responseBytes?.responseType !== id_pkix_ocsp_basic) {
    throw new OcspError('OCSP response is not a BasicOCSPResponse');
  }
  let basic: BasicOCSPResponse;
  try {
    basic = AsnConvert.parse(response.responseBytes.response.buffer, BasicOCSPResponse);
  } catch (err) {
    throw new OcspError('OCSP response carries a malformed BasicOCSPResponse', { cause: err });
  }
  const tbsRaw = basic.tbsResponseDataRaw;
  if (tbsRaw == null) throw new OcspError('OCSP response data could not be read');

  const included = basic.certs ?? [];
  if (included.length > MAX_OCSP_CARRIED_CERTS) {
    throw new OcspError(
      `OCSP response carries more than ${String(MAX_OCSP_CARRIED_CERTS)} certificates`,
    );
  }
  const carried = [...included, ...intermediates];
  const knownIssuer = knownIssuers.find((c) => isIssuerOf(c, certId));
  const issuer = knownIssuer ?? carried.find((c) => isIssuerOf(c, certId));
  if (issuer == null) {
    throw new OcspError('Issuer of the certificate is unknown, cannot verify the OCSP response');
  }
  if (knownIssuer != null && !isWithinValidity(knownIssuer, now)) {
    throw new OcspError('Known issuer of the certificate is outside its validity period');
  }
  if (knownIssuer == null && !chainsToKnownCa(issuer, carried, knownIssuers, now)) {
    throw new OcspError(
      'Issuer carried in the OCSP response has no chain to a known CA, cannot verify the response',
    );
  }

  let responder: Certificate | undefined;
  if (matchesResponderId(basic, issuer)) {
    responder = issuer;
  } else {
    responder = included.find(
      (c) =>
        matchesResponderId(basic, c) &&
        hasOcspSigningEku(c) &&
        isWithinValidity(c, now) &&
        sameBytes(
          AsnConvert.serialize(c.tbsCertificate.issuer),
          AsnConvert.serialize(issuer.tbsCertificate.subject),
        ) &&
        verifySignature(
          c.signatureAlgorithm,
          AsnConvert.serialize(c.tbsCertificate),
          c.signatureValue,
          issuer,
        ),
    );
  }
  if (responder == null) {
    throw new OcspError('OCSP response is not signed by the issuer or an authorized responder');
  }
  if (!verifySignature(basic.signatureAlgorithm, tbsRaw, basic.signature, responder)) {
    throw new OcspError('OCSP response signature is invalid');
  }

  const requested = toCertId(certId);
  const single = basic.tbsResponseData.responses.find(
    (r) =>
      r.certID.hashAlgorithm.algorithm === requested.hashAlgorithm.algorithm &&
      sameBytes(r.certID.issuerNameHash.buffer, requested.issuerNameHash.buffer) &&
      sameBytes(r.certID.issuerKeyHash.buffer, requested.issuerKeyHash.buffer) &&
      normalizeSerialHex(Buffer.from(r.certID.serialNumber).toString('hex')) ===
        normalizeSerialHex(certId.serialNumber),
  );
  if (single == null) throw new OcspError('OCSP response does not cover the certificate');
  if (single.thisUpdate.getTime() > now + CLOCK_SKEW_MS) {
    throw new OcspError('OCSP response thisUpdate is in the future');
  }
  if (single.nextUpdate != null && single.nextUpdate.getTime() < now - CLOCK_SKEW_MS) {
    throw new OcspError('OCSP response is stale (nextUpdate has passed)');
  }
  if (
    single.nextUpdate == null &&
    single.thisUpdate.getTime() < now - OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_MS
  ) {
    throw new OcspError('OCSP response without nextUpdate is stale (thisUpdate too old)');
  }

  if (single.certStatus.revoked != null) return 'revoked';
  if (single.certStatus.unknown !== undefined) return 'unknown';
  if (single.certStatus.good !== undefined) return 'good';
  throw new OcspError('OCSP response has no certificate status');
}

/**
 * Sends the OCSP request for OCPP OCSPRequestData to its responder and
 * returns the DER OCSPResponse. Throws OcspError when the responder URL is
 * not allowed (see isOcspResponderAllowed), the data is malformed, or the
 * request fails.
 */
export async function fetchOcspResponse(data: OcspRequestData): Promise<Buffer> {
  const allowedPrivateHosts = await getOcspAllowedPrivateHosts();
  if (!isOcspResponderAllowed(data.responderURL, allowedPrivateHosts)) {
    throw new OcspError(
      'Responder URL is not http(s) or is a private address not in pnc.ocsp.allowedPrivateHosts',
    );
  }
  return postOcspRequest(data.responderURL, buildOcspRequest(data), allowedPrivateHosts);
}

/**
 * M06 GetCertificateStatus: fetches the OCSP response for the station and
 * returns it base64 encoded (M06.FR.03, FR.08, FR.09). Accepted only for a
 * DER OCSPResponse with responseStatus successful that fits ocspResult;
 * otherwise Failed with the reason (M06.FR.04).
 */
export async function getOcspResultForStation(
  data: OcspRequestData,
): Promise<OcspResult & { reason?: string }> {
  try {
    const der = await fetchOcspResponse(data);
    const response = parseOcspResponse(der);
    if (response.responseStatus !== OCSPResponseStatus.successful) {
      return {
        status: 'Failed',
        ocspResult: '',
        reason: `OCSP responder returned status ${OCSPResponseStatus[response.responseStatus]}`,
      };
    }
    const ocspResult = der.toString('base64');
    if (ocspResult.length > MAX_OCSP_RESULT_LENGTH) {
      return {
        status: 'Failed',
        ocspResult: '',
        reason: 'OCSP response exceeds ocspResult maxLength',
      };
    }
    return { status: 'Accepted', ocspResult };
  } catch (err) {
    return {
      status: 'Failed',
      ocspResult: '',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
