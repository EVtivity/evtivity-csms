// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeMessage,
  decryptContractKeyIso2,
  decryptContractKeyIso20,
  encodeSigned,
  iso20Aad,
  ISO2_SIGNATURE,
  ISO20_SIGNATURE,
  privateScalar,
  verifySignature,
  type DecodedIso20Message,
  type Iso2CertificateRes,
  type Iso20CertificateInstallationRes,
} from '@evtivity/v2g-exi';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

// ---------------------------------------------------------------- fake DB

interface ContractRow {
  id: number;
  id_token: string;
  pcid: string;
  status: 'active' | 'revoked';
}

const { db, client } = vi.hoisted(() => {
  const state = {
    oemRootPem: '',
    contracts: [] as ContractRow[],
    issued: [] as Array<{ contractId: number; schema: number; serial: string; pcid: string }>,
  };
  function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sql = strings.join('?');
    if (sql.includes('FROM pki_ca_certificates')) {
      return Promise.resolve(
        state.oemRootPem === ''
          ? []
          : [{ certificate: state.oemRootPem, certificate_type: 'OEMRootCertificate' }],
      );
    }
    if (sql.includes('FROM pnc_contracts') && sql.includes('c.pcid = ')) {
      const pcid = values[0];
      return Promise.resolve(
        state.contracts
          .filter((c) => c.pcid === pcid && c.status === 'active')
          .map((c) => ({ id: c.id, id_token: c.id_token })),
      );
    }
    if (sql.includes('FROM pnc_contracts') && sql.includes('t.id_token = ')) {
      const emaid = values[0];
      return Promise.resolve(
        state.contracts
          .filter((c) => c.id_token === emaid && c.status === 'active')
          .map((c) => ({ id: c.id, id_token: c.id_token, pcid: c.pcid })),
      );
    }
    if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([{}]);
    if (sql.includes('count(*)::int AS delivered')) {
      const pcid = values[1];
      return Promise.resolve([
        { delivered: state.issued.filter((i) => i.schema === 20 && i.pcid === pcid).length },
      ]);
    }
    if (sql.includes('INSERT INTO pnc_contract_certificates')) {
      state.issued.push({
        contractId: values[0] as number,
        pcid: values[2] as string,
        schema: values[3] as number,
        serial: values[4] as string,
      });
      return Promise.resolve([]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  const fake = Object.assign(fakeSql, {
    begin: (fn: (tx: typeof fakeSql) => Promise<unknown>) => fn(fakeSql),
  });
  return { db: state, client: fake };
});

vi.mock('@evtivity/database', () => ({
  client,
  getOcspAllowedPrivateHosts: () => Promise.resolve([]),
}));

const store = vi.hoisted((): { ca: object | null } => ({ ca: null }));
vi.mock('../../../services/pki/local-ca-store.js', () => ({
  getLocalContractCa: () => Promise.resolve(store.ca),
}));

import {
  createLocalContractCa,
  type LocalContractCa,
} from '../../../services/pki/local-contract-ca.js';
import {
  chainsTo,
  clearOemTrustCache,
  LocalContractProvider,
  orderContracts,
  pcidOf,
  schemaOf,
} from '../../../services/pki/local-contract-provider.js';

// ---------------------------------------------------------------- test OEM PKI

interface Oem {
  root: x509.X509Certificate;
  leaf: x509.X509Certificate;
  leafKey: crypto.KeyObject;
}

async function oemPki(curve: 'P-256' | 'P-521', pcid: string): Promise<Oem> {
  const alg = { name: 'ECDSA', namedCurve: curve, hash: curve === 'P-256' ? 'SHA-256' : 'SHA-512' };
  const rootKeys = (await webcrypto.subtle.generateKey(alg, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const leafKeys = (await webcrypto.subtle.generateKey(alg, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const now = Date.now();
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=Test OEM Root ${curve}`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: alg,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: `CN=${pcid}`,
    issuer: root.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(false)],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey));
  return {
    root,
    leaf,
    leafKey: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  };
}

let ca: LocalContractCa;
let oem2: Oem;
let oem20: Oem;
const PCID2 = 'WMI2TEST000000001A';
const PCID20 = 'WMI20TEST00000001B';

beforeAll(async () => {
  ca = await createLocalContractCa();
  oem2 = await oemPki('P-256', PCID2);
  oem20 = await oemPki('P-521', PCID20);
}, 60_000);

beforeEach(() => {
  store.ca = ca;
  db.oemRootPem = oem2.root.toString('pem');
  db.contracts = [];
  db.issued = [];
  clearOemTrustCache();
});

function installReq2(oem: Oem): string {
  return encodeSigned(
    {
      schema: 2,
      sessionId: '0102030405060708',
      body: {
        type: 'CertificateInstallationReq',
        id: 'req',
        oemProvisioningCert: Buffer.from(oem.leaf.rawData),
        rootCertificateIds: [{ issuerName: 'CN=EVtivity V2G Root,O=EVtivity', serialNumber: '01' }],
      },
    },
    ['req'],
    ISO2_SIGNATURE,
    oem.leafKey,
  ).exi.toString('base64');
}

function installReq20(oem: Oem, prioritized: string[]): string {
  return encodeSigned(
    {
      schema: 20,
      sessionId: '0a0b0c0d0e0f1011',
      timestamp: 1n,
      body: {
        type: 'CertificateInstallationReq',
        oemProvisioningChain: {
          id: 'oem',
          certificate: Buffer.from(oem.leaf.rawData),
          subCertificates: [],
        },
        rootCertificateIds: [{ issuerName: 'CN=EVtivity V2G Root 20', serialNumber: '01' }],
        maximumContractCertificateChains: 10,
        prioritizedEmaids: prioritized,
      },
    },
    ['oem'],
    ISO20_SIGNATURE,
    oem.leafKey,
  ).exi.toString('base64');
}

const provider = new LocalContractProvider();
const ISO2 = 'urn:iso:15118:2:2013:MsgDef';
const ISO20 = 'urn:iso:std:iso:15118:-20:CommonMessages';

describe('schemaOf and pcidOf', () => {
  it('maps the schema version strings', () => {
    expect(schemaOf(ISO2)).toBe(2);
    expect(schemaOf(ISO20)).toBe(20);
    expect(schemaOf('20')).toBe(20);
    expect(schemaOf('2')).toBe(2);
    expect(schemaOf('urn:din:70121:2012:MsgDef')).toBeNull();
  });

  it('takes the PCID from the CN without separators', () => {
    const cert = new crypto.X509Certificate(Buffer.from(oem2.leaf.rawData));
    expect(pcidOf(cert)).toBe(PCID2);
  });
});

describe('orderContracts', () => {
  it('puts prioritized eMAIDs first and caps at the maximum', () => {
    const contracts = [
      { id: 1, emaid: 'A' },
      { id: 2, emaid: 'B' },
      { id: 3, emaid: 'C' },
    ];
    expect(orderContracts(contracts, ['C', 'B'], 10).map((c) => c.emaid)).toEqual(['C', 'B', 'A']);
    expect(orderContracts(contracts, [], 2).map((c) => c.emaid)).toEqual(['A', 'B']);
    expect(orderContracts(contracts, [], 0)).toEqual([]);
  });
});

describe('ISO 15118-2 installation and update', () => {
  it('installs a contract the EV can decrypt and verify', async () => {
    db.contracts = [{ id: 7, id_token: 'USEVTC00000001', pcid: PCID2, status: 'active' }];
    const result = await provider.getContractCertificate({
      stationDbId: 'sta_1',
      iso15118SchemaVersion: ISO2,
      action: 'Install',
      exiRequest: installReq2(oem2),
    });
    expect(result.status).toBe('Accepted');
    expect(result.remainingContracts).toBeUndefined();

    const res = decodeMessage(2, Buffer.from(result.exiResponse, 'base64'));
    const body = res.body as Iso2CertificateRes;
    expect(res.sessionId).toBe('0102030405060708');
    expect(body.type).toBe('CertificateInstallationRes');
    expect(body.emaid.value).toBe('USEVTC00000001');

    // Signed by the CPS leaf, which chains to the local V2G root.
    const cps = new crypto.X509Certificate(body.saProvisioningChain.certificate);
    const ids = ['id1', 'id2', 'id3', 'id4'];
    expect(verifySignature(res, ids, ISO2_SIGNATURE, cps.publicKey).valid).toBe(true);
    const cpsSubs = body.saProvisioningChain.subCertificates.map(
      (d) => new crypto.X509Certificate(d),
    );
    expect(chainsTo(cps, cpsSubs, [], [new crypto.X509Certificate(ca.iso2.cpsRoot.cert)])).toBe(
      true,
    );

    // The contract certificate chains to the MO root and matches the decrypted key.
    const contract = new crypto.X509Certificate(body.contractChain.certificate);
    expect(contract.subject).toContain('CN=USEVTC00000001');
    const moSubs = body.contractChain.subCertificates.map((d) => new crypto.X509Certificate(d));
    expect(chainsTo(contract, moSubs, [], [new crypto.X509Certificate(ca.iso2.moRoot.cert)])).toBe(
      true,
    );
    const key = decryptContractKeyIso2(
      oem2.leafKey,
      body.dhPublicKey.value,
      body.encryptedPrivateKey.value,
    );
    const signature = crypto.sign('sha256', Buffer.from('x'), key);
    expect(crypto.verify('sha256', Buffer.from('x'), contract.publicKey, signature)).toBe(true);
    expect(db.issued).toEqual([expect.objectContaining({ contractId: 7, schema: 2, pcid: PCID2 })]);

    // Update: signed with the installed contract key, encrypted to it.
    const update = encodeSigned(
      {
        schema: 2,
        sessionId: '1111111111111111',
        body: {
          type: 'CertificateUpdateReq',
          id: 'upd',
          contractChain: {
            certificate: body.contractChain.certificate,
            subCertificates: body.contractChain.subCertificates,
          },
          emaid: 'USEVTC00000001',
          rootCertificateIds: [
            { issuerName: 'CN=EVtivity V2G Root,O=EVtivity', serialNumber: '01' },
          ],
        },
      },
      ['upd'],
      ISO2_SIGNATURE,
      key,
    );
    const updated = await provider.getContractCertificate({
      stationDbId: 'sta_1',
      iso15118SchemaVersion: ISO2,
      action: 'Update',
      exiRequest: update.exi.toString('base64'),
    });
    expect(updated.status).toBe('Accepted');
    const updRes = decodeMessage(2, Buffer.from(updated.exiResponse, 'base64'));
    const updBody = updRes.body as Iso2CertificateRes;
    expect(updBody.type).toBe('CertificateUpdateRes');
    const newKey = decryptContractKeyIso2(
      key,
      updBody.dhPublicKey.value,
      updBody.encryptedPrivateKey.value,
    );
    expect(privateScalar(newKey).equals(privateScalar(key))).toBe(false);
    expect(db.issued).toHaveLength(2);
  });

  it('fails without an active contract for the PCID', async () => {
    const result = await provider.getContractCertificate({
      stationDbId: 'sta_1',
      iso15118SchemaVersion: ISO2,
      action: 'Install',
      exiRequest: installReq2(oem2),
    });
    expect(result).toEqual({ status: 'Failed', exiResponse: '' });
  });

  it('fails when the OEM provisioning certificate does not chain to an installed OEM root', async () => {
    db.contracts = [{ id: 7, id_token: 'USEVTC00000001', pcid: PCID2, status: 'active' }];
    db.oemRootPem = oem20.root.toString('pem');
    const result = await provider.getContractCertificate({
      stationDbId: 'sta_1',
      iso15118SchemaVersion: ISO2,
      action: 'Install',
      exiRequest: installReq2(oem2),
    });
    expect(result.status).toBe('Failed');
  });

  it('fails a request signed with another key, garbage EXI, a mismatched action, or no CA', async () => {
    db.contracts = [{ id: 7, id_token: 'USEVTC00000001', pcid: PCID2, status: 'active' }];
    const forged = encodeSigned(
      {
        schema: 2,
        sessionId: '01',
        body: {
          type: 'CertificateInstallationReq',
          id: 'req',
          oemProvisioningCert: Buffer.from(oem2.leaf.rawData),
          rootCertificateIds: [{ issuerName: 'CN=Root', serialNumber: '01' }],
        },
      },
      ['req'],
      ISO2_SIGNATURE,
      crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
    );
    const base = { stationDbId: 'sta_1', iso15118SchemaVersion: ISO2 } as const;
    expect(
      (
        await provider.getContractCertificate({
          ...base,
          action: 'Install',
          exiRequest: forged.exi.toString('base64'),
        })
      ).status,
    ).toBe('Failed');
    expect(
      (
        await provider.getContractCertificate({
          ...base,
          action: 'Install',
          exiRequest: 'bm90IGV4aQ==',
        })
      ).status,
    ).toBe('Failed');
    expect(
      (
        await provider.getContractCertificate({
          ...base,
          action: 'Update',
          exiRequest: installReq2(oem2),
        })
      ).status,
    ).toBe('Failed');
    expect(
      (
        await provider.getContractCertificate({
          ...base,
          iso15118SchemaVersion: 'urn:din:70121:2012:MsgDef',
          action: 'Install',
          exiRequest: installReq2(oem2),
        })
      ).status,
    ).toBe('Failed');
    store.ca = null;
    expect(
      (
        await provider.getContractCertificate({
          ...base,
          action: 'Install',
          exiRequest: installReq2(oem2),
        })
      ).status,
    ).toBe('Failed');
    expect(db.issued).toHaveLength(0);
  });
});

describe('ISO 15118-20 installation loop', () => {
  it('delivers each contract once with remainingContracts 2, 1, 0', async () => {
    db.oemRootPem = oem20.root.toString('pem');
    db.contracts = [
      { id: 1, id_token: 'USEVTC00000011', pcid: PCID20, status: 'active' },
      { id: 2, id_token: 'USEVTC00000012', pcid: PCID20, status: 'active' },
      { id: 3, id_token: 'USEVTC00000013', pcid: PCID20, status: 'active' },
      { id: 4, id_token: 'USEVTC00000099', pcid: 'OTHERPCID', status: 'active' },
    ];
    const exiRequest = installReq20(oem20, ['USEVTC00000013']);
    const emaids: string[] = [];
    const remaining: Array<number | undefined> = [];
    for (let i = 0; i < 3; i++) {
      const result = await provider.getContractCertificate({
        stationDbId: 'sta_1',
        iso15118SchemaVersion: ISO20,
        action: 'Install',
        exiRequest,
        maximumContractCertificateChains: 10,
      });
      expect(result.status).toBe('Accepted');
      remaining.push(result.remainingContracts);
      const res = decodeMessage(
        20,
        Buffer.from(result.exiResponse, 'base64'),
      ) as DecodedIso20Message;
      const body = res.body as Iso20CertificateInstallationRes;
      expect(body.remainingContractCertificateChains).toBe(result.remainingContracts);
      const cps = new crypto.X509Certificate(body.cpsChain.certificate);
      expect(verifySignature(res, ['id1'], ISO20_SIGNATURE, cps.publicKey).valid).toBe(true);
      const contract = new crypto.X509Certificate(
        body.signedInstallationData.contractChain.certificate,
      );
      const emaid = contract.subject.split('\n')[0]?.slice(3) ?? '';
      emaids.push(emaid);
      const ski = new x509.X509Certificate(contract.raw).getExtension(
        x509.SubjectKeyIdentifierExtension,
      );
      expect(ski?.keyId).toHaveLength(16);
      const enc = body.signedInstallationData.encryptedPrivateKey;
      expect(enc?.kind).toBe('SECP521');
      const key = decryptContractKeyIso20(
        oem20.leafKey,
        body.signedInstallationData.dhPublicKey,
        enc?.value ?? Buffer.alloc(0),
        iso20Aad(PCID20, ski?.keyId ?? ''),
      );
      const sig = crypto.sign('sha512', Buffer.from('x'), key);
      expect(crypto.verify('sha512', Buffer.from('x'), contract.publicKey, sig)).toBe(true);
    }
    expect(remaining).toEqual([2, 1, 0]);
    expect(emaids).toEqual(['USEVTC00000013', 'USEVTC00000011', 'USEVTC00000012']);
  });

  it('fails an ISO 15118-20 update and an unsigned request', async () => {
    db.oemRootPem = oem20.root.toString('pem');
    db.contracts = [{ id: 1, id_token: 'USEVTC00000011', pcid: PCID20, status: 'active' }];
    const base = { stationDbId: 'sta_1', iso15118SchemaVersion: ISO20 } as const;
    expect(
      (
        await provider.getContractCertificate({
          ...base,
          action: 'Update',
          exiRequest: installReq20(oem20, []),
        })
      ).status,
    ).toBe('Failed');
    // An ISO 15118-2 key cannot sign an ISO 15118-20 request.
    expect(
      (
        await provider.getContractCertificate({
          ...base,
          action: 'Install',
          exiRequest: installReq2(oem2),
        })
      ).status,
    ).toBe('Failed');
  });
});
