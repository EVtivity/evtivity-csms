// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// PKI provider for pnc.provider = 'local': the CSMS acts as the contract
// certificate provisioning service with its own contract CA (OCPP 2.1 M01
// Certificate installation, M02 Certificate update). CSRs are queued for
// manual signing like the manual provider.
//
// ISO 15118-2 (CertificateInstallationReq / CertificateUpdateReq): one
// contract per request. ISO 15118-20 (CertificateInstallationReq): one
// contract per request, the rest counted in remainingContracts; the station
// repeats the request until it reaches 0 (M01.FR.04 to FR.07).
//
// Every failure answers Failed (fail closed): an unknown schema, an EXI
// stream that does not decode, a signature that does not verify, an OEM
// provisioning certificate that does not chain to an OEM root the operator
// installed, no active contract bound to the vehicle's PCID, or no CA.

import crypto, { type KeyObject } from 'node:crypto';
import { client } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import {
  decodeMessage,
  encodeSigned,
  encryptContractKeyIso2,
  encryptContractKeyIso20,
  iso20Aad,
  Iso2ResponseCode,
  Iso20EcdhCurve,
  Iso20Processing,
  Iso20ResponseCode,
  ISO2_SIGNATURE,
  ISO20_SIGNATURE,
  verifySignature,
  type DecodedIso2Message,
  type DecodedIso20Message,
  type Iso15118Schema,
} from '@evtivity/v2g-exi';
import type {
  ContractCertRequest,
  ContractCertResult,
  OcspRequestData,
  OcspResult,
  PkiProvider,
  SignCsrResult,
} from './pki-provider.js';
import { ManualProvider } from './manual-provider.js';
import { getLocalContractCa } from './local-ca-store.js';
import {
  hierarchyFor,
  issueContractCertificate,
  pemToDer,
  type LocalCaHierarchy,
} from './local-contract-ca.js';

const logger = createLogger('local-contract-provider');

const FAILED: ContractCertResult = { status: 'Failed', exiResponse: '' };

/** A contract delivered within this window counts toward the current ISO 15118-20 loop. */
export const DELIVERY_WINDOW_MINUTES = 5;

/** ISO 15118 schema of a Get15118EVCertificateRequest, or null when unsupported. */
export function schemaOf(iso15118SchemaVersion: string): Iso15118Schema | null {
  const v = iso15118SchemaVersion.trim();
  if (v === '20' || v === '-20' || v.includes(':-20')) return 20;
  if (v === '2' || v === '-2' || v.includes('15118:2:')) return 2;
  return null;
}

/** PCID from the OEM provisioning certificate: its CN in upper case without separators. */
export function pcidOf(cert: crypto.X509Certificate): string | null {
  const cn = cert.subject
    .split('\n')
    .find((part) => part.startsWith('CN='))
    ?.slice(3);
  if (cn == null) return null;
  const pcid = cn.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return pcid === '' ? null : pcid.slice(0, 64);
}

function emaidOf(cert: crypto.X509Certificate): string | null {
  return (
    cert.subject
      .split('\n')
      .find((part) => part.startsWith('CN='))
      ?.slice(3) ?? null
  );
}

// ------------------------------------------------------------ trust anchors

const TRUST_TTL_MS = 60_000;
let trustCache: {
  roots: crypto.X509Certificate[];
  all: crypto.X509Certificate[];
  at: number;
} | null = null;

export function clearOemTrustCache(): void {
  trustCache = null;
}

async function loadOemTrust(): Promise<{
  roots: crypto.X509Certificate[];
  all: crypto.X509Certificate[];
}> {
  if (trustCache != null && Date.now() - trustCache.at < TRUST_TTL_MS) return trustCache;
  const rows = await client`
    SELECT id, certificate, certificate_type FROM pki_ca_certificates WHERE status = 'active'
  `;
  const roots: crypto.X509Certificate[] = [];
  const all: crypto.X509Certificate[] = [];
  for (const row of rows) {
    try {
      const cert = new crypto.X509Certificate(row.certificate as string);
      all.push(cert);
      if (row.certificate_type === 'OEMRootCertificate') roots.push(cert);
    } catch (err) {
      logger.warn(
        { err, caCertificateId: row.id, certificateType: row.certificate_type },
        'Active CA certificate does not parse; leaving it out of the OEM trust store',
      );
    }
  }
  trustCache = { roots, all, at: Date.now() };
  return trustCache;
}

function currentlyValid(cert: crypto.X509Certificate, now: number): boolean {
  return now >= Date.parse(cert.validFrom) && now <= Date.parse(cert.validTo);
}

function issuedBy(cert: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    // fail-open: a signature that cannot be checked counts as not issued, so the chain is refused
    return false;
  }
}

/**
 * Builds a path from `leaf` through `intermediates` (from the request) and
 * the operator's CA certificates to one of `roots`. Every certificate must be
 * within its validity period.
 */
export function chainsTo(
  leaf: crypto.X509Certificate,
  intermediates: crypto.X509Certificate[],
  pool: crypto.X509Certificate[],
  roots: crypto.X509Certificate[],
): boolean {
  const now = Date.now();
  const candidates = [...intermediates, ...pool];
  let current = leaf;
  for (let depth = 0; depth < 6; depth++) {
    if (!currentlyValid(current, now)) return false;
    const root = roots.find((r) => issuedBy(current, r));
    if (root != null) return currentlyValid(root, now);
    const next = candidates.find(
      (c) => c.ca && c.fingerprint256 !== current.fingerprint256 && issuedBy(current, c),
    );
    if (next == null) return false;
    current = next;
  }
  return false;
}

// ------------------------------------------------------------ contracts

interface Contract {
  id: number;
  emaid: string;
}

async function contractsForPcid(pcid: string): Promise<Contract[]> {
  const rows = await client`
    SELECT c.id, t.id_token
    FROM pnc_contracts c
    JOIN driver_tokens t ON t.id = c.driver_token_id
    WHERE c.pcid = ${pcid}
      AND c.status = 'active'
      AND t.token_type = 'eMAID'
      AND t.is_active = true
      AND (t.expires_at IS NULL OR t.expires_at > now())
    ORDER BY c.created_at, c.id
  `;
  return rows.map((r) => ({ id: r.id as number, emaid: r.id_token as string }));
}

async function contractForEmaid(emaid: string): Promise<(Contract & { pcid: string }) | null> {
  const rows = await client`
    SELECT c.id, c.pcid, t.id_token
    FROM pnc_contracts c
    JOIN driver_tokens t ON t.id = c.driver_token_id
    WHERE t.id_token = ${emaid}
      AND c.status = 'active'
      AND t.token_type = 'eMAID'
      AND t.is_active = true
      AND (t.expires_at IS NULL OR t.expires_at > now())
    LIMIT 1
  `;
  const row = rows[0];
  if (row == null) return null;
  return { id: row.id as number, emaid: row.id_token as string, pcid: row.pcid as string };
}

/** ISO 15118-20 delivery order: the request's prioritized eMAIDs first, then by creation. */
export function orderContracts(
  contracts: Contract[],
  prioritized: string[],
  maximum: number,
): Contract[] {
  const rank = (c: Contract): number => {
    const i = prioritized.indexOf(c.emaid);
    return i === -1 ? prioritized.length : i;
  };
  return [...contracts]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c)
    .slice(0, Math.max(0, maximum));
}

// ------------------------------------------------------------ provider

function keyPair(schema: Iso15118Schema): { publicKey: KeyObject; privateKey: KeyObject } {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: schema === 2 ? 'prime256v1' : 'secp521r1',
  });
}

function chainParts(h: LocalCaHierarchy): {
  cps: { certificate: Buffer; subCertificates: Buffer[] };
  moSubs: Buffer[];
} {
  return {
    cps: {
      certificate: pemToDer(h.cpsLeaf.cert),
      subCertificates: [pemToDer(h.cpsSubCa2.cert), pemToDer(h.cpsSubCa1.cert)],
    },
    moSubs: [pemToDer(h.moSubCa2.cert), pemToDer(h.moSubCa1.cert)],
  };
}

function cpsKey(h: LocalCaHierarchy): KeyObject {
  if (h.cpsLeaf.key == null) throw new Error('Local contract CA has no CPS leaf key');
  return crypto.createPrivateKey(h.cpsLeaf.key);
}

async function recordCertificate(
  sql: typeof client,
  contractId: number,
  stationDbId: string | null,
  pcid: string,
  schema: Iso15118Schema,
  serialNumber: string,
  validTo: Date,
): Promise<void> {
  await sql`
    INSERT INTO pnc_contract_certificates
      (contract_id, station_id, pcid, schema_version, serial_number, valid_to)
    VALUES (${contractId}, ${stationDbId}, ${pcid}, ${schema}, ${serialNumber}, ${validTo})
  `;
}

export class LocalContractProvider implements PkiProvider {
  // CSRs, OCSP and root certificates work as with the manual provider.
  private readonly manual = new ManualProvider();

  signCsr(
    csr: string,
    certificateType: string,
    stationDbId: string | null,
  ): Promise<SignCsrResult> {
    return this.manual.signCsr(csr, certificateType, stationDbId);
  }

  getOcspStatus(ocspRequestData: OcspRequestData): Promise<OcspResult> {
    return this.manual.getOcspStatus(ocspRequestData);
  }

  getRootCertificates(type: string): Promise<string[]> {
    return this.manual.getRootCertificates(type);
  }

  async getContractCertificate(request: ContractCertRequest): Promise<ContractCertResult> {
    const schema = schemaOf(request.iso15118SchemaVersion);
    if (schema == null) {
      logger.warn(
        { iso15118SchemaVersion: request.iso15118SchemaVersion },
        'Unsupported ISO 15118 schema version',
      );
      return FAILED;
    }
    const ca = await getLocalContractCa();
    if (ca == null) {
      logger.warn('No local contract CA: create one in Settings > Plug & Charge');
      return FAILED;
    }
    const exi = Buffer.from(request.exiRequest, 'base64');
    let decoded: DecodedIso2Message | DecodedIso20Message;
    try {
      decoded = decodeMessage(schema, exi);
    } catch (err) {
      logger.warn({ err, schema }, 'exiRequest does not decode as an ISO 15118 message');
      return FAILED;
    }
    try {
      if (decoded.schema === 2) return await this.iso2(request, decoded, hierarchyFor(ca, 2));
      return await this.iso20(request, decoded, hierarchyFor(ca, 20));
    } catch (err) {
      logger.error({ err, schema }, 'Contract certificate provisioning failed');
      return FAILED;
    }
  }

  private async iso2(
    request: ContractCertRequest,
    message: DecodedIso2Message,
    hierarchy: LocalCaHierarchy,
  ): Promise<ContractCertResult> {
    const body = message.body;
    let recipient: KeyObject;
    let contract: Contract;
    let pcid: string;

    if (body.type === 'CertificateInstallationReq' && request.action === 'Install') {
      const oem = new crypto.X509Certificate(body.oemProvisioningCert);
      const check = verifySignature(message, [body.id], ISO2_SIGNATURE, oem.publicKey);
      if (!check.valid) {
        logger.warn({ reason: check.reason }, 'CertificateInstallationReq signature invalid');
        return FAILED;
      }
      const trust = await loadOemTrust();
      if (!chainsTo(oem, [], trust.all, trust.roots)) {
        logger.warn('OEM provisioning certificate does not chain to an installed OEM root');
        return FAILED;
      }
      const id = pcidOf(oem);
      if (id == null) return FAILED;
      pcid = id;
      const contracts = await contractsForPcid(pcid);
      const latest = contracts[contracts.length - 1];
      if (latest == null) {
        logger.warn({ pcid }, 'No active contract for the PCID');
        return FAILED;
      }
      contract = latest;
      recipient = oem.publicKey;
    } else if (body.type === 'CertificateUpdateReq' && request.action === 'Update') {
      const current = new crypto.X509Certificate(body.contractChain.certificate);
      const check = verifySignature(message, [body.id], ISO2_SIGNATURE, current.publicKey);
      if (!check.valid) {
        logger.warn({ reason: check.reason }, 'CertificateUpdateReq signature invalid');
        return FAILED;
      }
      // Only contracts this CA issued are updated: the current certificate
      // must chain to the local MO root.
      const subs = body.contractChain.subCertificates.map((d) => new crypto.X509Certificate(d));
      const moRoot = new crypto.X509Certificate(hierarchy.moRoot.cert);
      const pool = [hierarchy.moSubCa1.cert, hierarchy.moSubCa2.cert].map(
        (pem) => new crypto.X509Certificate(pem),
      );
      if (!chainsTo(current, subs, pool, [moRoot])) {
        logger.warn('Contract certificate to update was not issued by the local contract CA');
        return FAILED;
      }
      if (emaidOf(current) !== body.emaid) {
        logger.warn('CertificateUpdateReq eMAID does not match the contract certificate');
        return FAILED;
      }
      const found = await contractForEmaid(body.emaid);
      if (found == null) {
        logger.warn({ emaid: body.emaid }, 'No active contract for the eMAID');
        return FAILED;
      }
      contract = found;
      pcid = found.pcid;
      recipient = current.publicKey;
    } else {
      logger.warn({ type: body.type, action: request.action }, 'Unexpected ISO 15118-2 message');
      return FAILED;
    }

    const keys = keyPair(2);
    const issued = await issueContractCertificate(hierarchy, 2, contract.emaid, keys.publicKey);
    const encrypted = encryptContractKeyIso2(recipient, keys.privateKey);
    const parts = chainParts(hierarchy);
    const res = encodeSigned(
      {
        schema: 2,
        sessionId: message.sessionId,
        body: {
          type:
            body.type === 'CertificateInstallationReq'
              ? 'CertificateInstallationRes'
              : 'CertificateUpdateRes',
          responseCode: Iso2ResponseCode.OK,
          saProvisioningChain: parts.cps,
          contractChain: {
            id: 'id1',
            certificate: issued.certificate,
            subCertificates: parts.moSubs,
          },
          encryptedPrivateKey: { id: 'id2', value: encrypted.encryptedPrivateKey },
          dhPublicKey: { id: 'id3', value: encrypted.dhPublicKey },
          emaid: { id: 'id4', value: contract.emaid },
        },
      },
      ['id1', 'id2', 'id3', 'id4'],
      ISO2_SIGNATURE,
      cpsKey(hierarchy),
    );
    await recordCertificate(
      client,
      contract.id,
      request.stationDbId,
      pcid,
      2,
      issued.serialNumber,
      issued.validTo,
    );
    logger.info(
      { pcid, emaid: contract.emaid, action: request.action },
      'Contract certificate issued (ISO 15118-2)',
    );
    return { status: 'Accepted', exiResponse: res.exi.toString('base64') };
  }

  private async iso20(
    request: ContractCertRequest,
    message: DecodedIso20Message,
    hierarchy: LocalCaHierarchy,
  ): Promise<ContractCertResult> {
    const body = message.body;
    if (body.type !== 'CertificateInstallationReq' || request.action !== 'Install') {
      logger.warn({ type: body.type, action: request.action }, 'Unexpected ISO 15118-20 message');
      return FAILED;
    }
    const oem = new crypto.X509Certificate(body.oemProvisioningChain.certificate);
    const check = verifySignature(
      message,
      [body.oemProvisioningChain.id],
      ISO20_SIGNATURE,
      oem.publicKey,
    );
    if (!check.valid) {
      logger.warn({ reason: check.reason }, 'CertificateInstallationReq signature invalid');
      return FAILED;
    }
    const trust = await loadOemTrust();
    const subs = body.oemProvisioningChain.subCertificates.map(
      (d) => new crypto.X509Certificate(d),
    );
    if (!chainsTo(oem, subs, trust.all, trust.roots)) {
      logger.warn('OEM provisioning certificate does not chain to an installed OEM root');
      return FAILED;
    }
    const pcid = pcidOf(oem);
    if (pcid == null) return FAILED;

    const prioritized =
      body.prioritizedEmaids.length > 0
        ? body.prioritizedEmaids
        : (request.prioritizedEMAIDs ?? []);
    const maximum =
      request.maximumContractCertificateChains ?? body.maximumContractCertificateChains;
    const candidates = orderContracts(await contractsForPcid(pcid), prioritized, maximum);
    if (candidates.length === 0) {
      logger.warn({ pcid }, 'No active contract for the PCID');
      return FAILED;
    }

    const keys = keyPair(20);
    const parts = chainParts(hierarchy);
    return client.begin(async (tx) => {
      // One loop at a time per station and vehicle, so concurrent requests
      // count deliveries consistently.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`pnc:${request.stationDbId ?? ''}:${pcid}`}))`;
      const [row] = await tx`
        SELECT count(*)::int AS delivered FROM pnc_contract_certificates
        WHERE station_id IS NOT DISTINCT FROM ${request.stationDbId}
          AND pcid = ${pcid} AND schema_version = 20
          AND issued_at > now() - make_interval(mins => ${DELIVERY_WINDOW_MINUTES})
      `;
      const position = ((row?.delivered as number | undefined) ?? 0) % candidates.length;
      const contract = candidates[position];
      if (contract == null) return FAILED;
      const remaining = candidates.length - position - 1;

      const issued = await issueContractCertificate(hierarchy, 20, contract.emaid, keys.publicKey);
      const encrypted = encryptContractKeyIso20(
        oem.publicKey,
        keys.privateKey,
        iso20Aad(pcid, issued.keyId),
      );
      const res = encodeSigned(
        {
          schema: 20,
          sessionId: message.sessionId,
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
          body: {
            type: 'CertificateInstallationRes',
            responseCode: Iso20ResponseCode.OK,
            evseProcessing: Iso20Processing.Finished,
            cpsChain: parts.cps,
            signedInstallationData: {
              id: 'id1',
              contractChain: { certificate: issued.certificate, subCertificates: parts.moSubs },
              ecdhCurve: Iso20EcdhCurve.SECP521,
              dhPublicKey: encrypted.dhPublicKey,
              encryptedPrivateKey: { kind: 'SECP521', value: encrypted.encryptedPrivateKey },
            },
            remainingContractCertificateChains: remaining,
          },
        },
        ['id1'],
        ISO20_SIGNATURE,
        cpsKey(hierarchy),
      );
      await recordCertificate(
        tx as unknown as typeof client,
        contract.id,
        request.stationDbId,
        pcid,
        20,
        issued.serialNumber,
        issued.validTo,
      );
      logger.info(
        { pcid, emaid: contract.emaid, remaining },
        'Contract certificate issued (ISO 15118-20)',
      );
      return {
        status: 'Accepted' as const,
        exiResponse: res.exi.toString('base64'),
        remainingContracts: remaining,
      };
    });
  }
}
