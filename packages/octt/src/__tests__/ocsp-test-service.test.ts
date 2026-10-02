// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { AlgorithmIdentifier } from '@peculiar/asn1-x509';
import { CertID, OCSPRequest, OCSPResponse, Request, TBSRequest } from '@peculiar/asn1-ocsp';
import {
  readRelayedOcspStatus,
  startOcspTestService,
  type OcspRequestData,
  type OcspTestService,
} from '../ocsp-test-service.js';

const PORT = 47190;
let service: OcspTestService;

beforeAll(async () => {
  service = await startOcspTestService(`http://127.0.0.1:${String(PORT)}/ocsp`);
});

afterAll(async () => {
  await service.responder.stop();
});

/** DER OCSPRequest for OCPP OCSPRequestData, as a CSMS builds it. */
function ocspRequest(data: OcspRequestData): Buffer {
  const serial = Buffer.from(
    data.serialNumber.length % 2 ? `0${data.serialNumber}` : data.serialNumber,
    'hex',
  );
  const serialInt = (serial[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), serial]) : serial;
  return Buffer.from(
    AsnConvert.serialize(
      new OCSPRequest({
        tbsRequest: new TBSRequest({
          requestList: [
            new Request({
              reqCert: new CertID({
                hashAlgorithm: new AlgorithmIdentifier({ algorithm: '2.16.840.1.101.3.4.2.1' }),
                issuerNameHash: new OctetString(Buffer.from(data.issuerNameHash, 'hex')),
                issuerKeyHash: new OctetString(Buffer.from(data.issuerKeyHash, 'hex')),
                serialNumber: new Uint8Array(serialInt).buffer,
              }),
            }),
          ],
        }),
      }),
    ),
  );
}

async function post(body: Buffer): Promise<Buffer> {
  const res = await fetch(`http://127.0.0.1:${String(PORT)}/ocsp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ocsp-request' },
    body: new Uint8Array(body),
  });
  expect(res.headers.get('content-type')).toBe('application/ocsp-response');
  return Buffer.from(await res.arrayBuffer());
}

describe('Test System OCSP service', () => {
  it('issues certificates whose AIA names the responder', () => {
    const data = service.pki.requestDataFor(service.pki.cpoSubCa2);
    expect(data.responderURL).toBe(`http://127.0.0.1:${String(PORT)}/ocsp`);
    expect(data.issuerKeyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers good for an issued certificate and records the request', async () => {
    const contract = await service.pki.issueContractCertificate('USOCTEMAID00001');
    const der = await post(ocspRequest(service.pki.requestDataFor(contract)));
    expect(readRelayedOcspStatus(der.toString('base64'), contract)).toBe('good');
    expect(service.responder.requestsFor(contract.cert.serialNumber)).toHaveLength(1);
  });

  it('answers revoked for a revoked certificate', async () => {
    const contract = await service.pki.issueContractCertificate('USOCTEMAID00002');
    service.pki.revoke(contract);
    const der = await post(ocspRequest(service.pki.requestDataFor(contract)));
    expect(readRelayedOcspStatus(der.toString('base64'), contract)).toBe('revoked');
  });

  it('answers unauthorized for an issuer it does not know and malformedRequest for garbage', async () => {
    const contract = await service.pki.issueContractCertificate('USOCTEMAID00003');
    const data = { ...service.pki.requestDataFor(contract), issuerKeyHash: '00'.repeat(32) };
    const unknownIssuer = AsnConvert.parse(await post(ocspRequest(data)), OCSPResponse);
    expect(unknownIssuer.responseStatus).toBe(6);
    const garbage = AsnConvert.parse(await post(Buffer.from('not der')), OCSPResponse);
    expect(garbage.responseStatus).toBe(1);
  });

  it('builds hash data for the contract chain: leaf and both MO SubCAs', async () => {
    const contract = await service.pki.issueContractCertificate('USOCTEMAID00004');
    const hashData = service.pki.contractHashData(contract);
    expect(hashData.map((d) => d.serialNumber)).toEqual(
      [contract, service.pki.moSubCa2, service.pki.moSubCa1].map((c) =>
        c.cert.serialNumber.toLowerCase().replace(/^0+/, ''),
      ),
    );
  });

  it('reports invalid for a relayed result that is not a signed OCSP response', () => {
    expect(readRelayedOcspStatus('', service.pki.cpoSubCa1)).toBe('invalid');
    expect(readRelayedOcspStatus('bm90LWRlcg==', service.pki.cpoSubCa1)).toBe('invalid');
  });
});
