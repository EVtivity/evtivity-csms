// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPP side of pki_csr_requests: every SignCertificateRequest a station
// sends (OCPP 2.1 A02, A03; 1.6 Security Whitepaper) becomes one row here,
// whatever the PKI provider, so the CSR, its requestId and its outcome can be
// traced. The operator sign and reject routes (API) change the pending rows a
// manual or local provider leaves.

import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { client } from '@evtivity/database';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface CsrRequestInput {
  stationDbId: string | null;
  csr: string;
  certificateType: string;
  /** SignCertificateRequest.requestId (2.1), echoed in CertificateSigned (A02.FR.25). */
  requestId: number | null;
}

/**
 * True when `pem` is a PEM PKCS#10 certificate signing request whose
 * signature verifies with its own public key (RFC 2986). A CSR that fails
 * this cannot be signed by any provider, so the CSMS answers Rejected
 * (A02.FR.12) instead of queueing it.
 */
export async function isValidCsr(pem: string): Promise<boolean> {
  if (!pem.includes('-----BEGIN CERTIFICATE REQUEST-----')) return false;
  try {
    const request = new x509.Pkcs10CertificateRequest(pem);
    return await request.verify();
  } catch {
    // fail-open: a CSR that does not parse is answered Rejected, which the caller reports
    return false;
  }
}

/** Records a station's CSR as pending and returns its id. */
export async function recordCsrRequest(input: CsrRequestInput): Promise<number> {
  const [row] = await client<Array<{ id: number }>>`
    INSERT INTO pki_csr_requests (csr, certificate_type, status, station_id, request_id)
    VALUES (${input.csr}, ${input.certificateType}, 'pending', ${input.stationDbId},
            ${input.requestId})
    RETURNING id
  `;
  if (row == null) throw new Error('CSR insert returned no row');
  return row.id;
}

/**
 * A provider that signs on its own (Hubject) could not sign the CSR: the row
 * ends rejected with the reason, still pending rows only (P5). The station
 * resends SignCertificate when no CertificateSigned arrives (A02.FR.17).
 */
export async function markCsrFailed(id: number, reason: string): Promise<void> {
  await client`
    UPDATE pki_csr_requests
    SET status = 'rejected', error_message = ${reason.slice(0, 2000)},
        completed_at = now(), updated_at = now()
    WHERE id = ${id} AND status IN ('pending', 'submitted')
  `;
}
