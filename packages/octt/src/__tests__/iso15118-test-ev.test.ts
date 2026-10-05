// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeMessage,
  encodeSigned,
  encryptContractKeyIso2,
  encryptContractKeyIso20,
  iso20Aad,
  ISO2_SIGNATURE,
  ISO20_SIGNATURE,
  verifySignature,
  type DecodedIso20Message,
  type Iso20CertificateInstallationReq,
} from '@evtivity/v2g-exi';
import {
  checkIso2Response,
  checkIso20Response,
  randomPcid,
  TestEv,
  updateRequest,
} from '../iso15118-test-ev.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

/** A self-signed certificate for a key pair, as a stand-in contract or CPS certificate. */
async function selfSigned(
  curve: 'P-256' | 'P-521',
  cn: string,
  ski?: string,
): Promise<{ der: Buffer; key: crypto.KeyObject }> {
  const alg = { name: 'ECDSA', namedCurve: curve, hash: curve === 'P-256' ? 'SHA-256' : 'SHA-512' };
  const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${cn}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: alg,
    keys,
    extensions: ski != null ? [new x509.SubjectKeyIdentifierExtension(ski)] : [],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    der: Buffer.from(cert.rawData),
    key: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  };
}

function oemPublicKey(ev: TestEv): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.from(ev.oemLeaf.publicKey.rawData),
    format: 'der',
    type: 'spki',
  });
}

let ev2: TestEv;
let ev20: TestEv;

beforeAll(async () => {
  ev2 = await TestEv.create(2);
  ev20 = await TestEv.create(20);
}, 30_000);

describe('TestEv', () => {
  it('makes 18 character PCIDs', () => {
    expect(randomPcid()).toMatch(/^OCTT[0-9A-Z]{14}$/);
  });

  it('signs an ISO 15118-2 CertificateInstallationReq with the OEM provisioning key', () => {
    const message = decodeMessage(2, Buffer.from(ev2.installationRequest(), 'base64'));
    expect(message.body.type).toBe('CertificateInstallationReq');
    const leaf = new crypto.X509Certificate(Buffer.from(ev2.oemLeaf.rawData));
    expect(leaf.subject).toContain(`CN=${ev2.pcid}`);
    expect(verifySignature(message, ['id1'], ISO2_SIGNATURE, leaf.publicKey).valid).toBe(true);
    expect(ev2.namespace).toBe('urn:iso:15118:2:2013:MsgDef');
  });

  it('signs an ISO 15118-20 CertificateInstallationReq over the OEM provisioning chain', () => {
    const message = decodeMessage(
      20,
      Buffer.from(
        ev20.installationRequest({
          maximumContractCertificateChains: 10,
          prioritizedEmaids: ['A'],
        }),
        'base64',
      ),
    ) as DecodedIso20Message;
    const body = message.body as Iso20CertificateInstallationReq;
    expect(body.maximumContractCertificateChains).toBe(10);
    expect(body.prioritizedEmaids).toEqual(['A']);
    const leaf = new crypto.X509Certificate(Buffer.from(ev20.oemLeaf.rawData));
    expect(verifySignature(message, ['id1'], ISO20_SIGNATURE, leaf.publicKey).valid).toBe(true);
  });
});

describe('response checks', () => {
  it('accepts a valid ISO 15118-2 CertificateInstallationRes and builds the update request', async () => {
    const cps = await selfSigned('P-256', 'CPS');
    const contract = await selfSigned('P-256', 'USOCTC00000001');
    const enc = encryptContractKeyIso2(oemPublicKey(ev2), contract.key);
    const exi = encodeSigned(
      {
        schema: 2,
        sessionId: '01',
        body: {
          type: 'CertificateInstallationRes',
          responseCode: 0,
          saProvisioningChain: { certificate: cps.der, subCertificates: [] },
          contractChain: { id: 'id1', certificate: contract.der, subCertificates: [] },
          encryptedPrivateKey: { id: 'id2', value: enc.encryptedPrivateKey },
          dhPublicKey: { id: 'id3', value: enc.dhPublicKey },
          emaid: { id: 'id4', value: 'USOCTC00000001' },
        },
      },
      ['id1', 'id2', 'id3', 'id4'],
      ISO2_SIGNATURE,
      cps.key,
    ).exi.toString('base64');
    const check = checkIso2Response(exi, 'CertificateInstallationRes', ev2.oemKey);
    expect(check).toMatchObject({ ok: true, contract: { emaid: 'USOCTC00000001' } });
    expect(checkIso2Response(exi, 'CertificateUpdateRes', ev2.oemKey)).toMatchObject({ ok: false });
    expect(checkIso2Response('AAAA', 'CertificateInstallationRes', ev2.oemKey)).toMatchObject({
      ok: false,
    });
    if (check.ok) {
      const update = decodeMessage(2, Buffer.from(updateRequest(check.contract), 'base64'));
      expect(update.body.type).toBe('CertificateUpdateReq');
      expect(
        verifySignature(
          update,
          ['id1'],
          ISO2_SIGNATURE,
          crypto.createPublicKey(check.contract.privateKey),
        ).valid,
      ).toBe(true);
    }
  });

  it('accepts a valid ISO 15118-20 CertificateInstallationRes and rejects a wrong AAD', async () => {
    const cps = await selfSigned('P-521', 'CPS 20');
    const contract = await selfSigned('P-521', 'USOCTC00000002', '0102030405060708');
    const build = (pcid: string): string => {
      const enc = encryptContractKeyIso20(
        oemPublicKey(ev20),
        contract.key,
        iso20Aad(pcid, '0102030405060708'),
      );
      return encodeSigned(
        {
          schema: 20,
          sessionId: '01',
          timestamp: 1n,
          body: {
            type: 'CertificateInstallationRes',
            responseCode: 0,
            evseProcessing: 0,
            cpsChain: { certificate: cps.der, subCertificates: [] },
            signedInstallationData: {
              id: 'id1',
              contractChain: { certificate: contract.der, subCertificates: [cps.der] },
              ecdhCurve: 0,
              dhPublicKey: enc.dhPublicKey,
              encryptedPrivateKey: { kind: 'SECP521', value: enc.encryptedPrivateKey },
            },
            remainingContractCertificateChains: 1,
          },
        },
        ['id1'],
        ISO20_SIGNATURE,
        cps.key,
      ).exi.toString('base64');
    };
    expect(checkIso20Response(build(ev20.pcid), ev20)).toMatchObject({
      ok: true,
      remaining: 1,
      contract: { emaid: 'USOCTC00000002' },
    });
    expect(checkIso20Response(build('OTHERPCID'), ev20)).toMatchObject({ ok: false });
  });
});
