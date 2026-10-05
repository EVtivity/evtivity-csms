// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(
  (): { ca: object | null; rows: Array<{ status: string; valid_to: Date }> } => ({
    ca: null,
    rows: [],
  }),
);

vi.mock('@evtivity/database', () => ({
  client: () => Promise.resolve(state.rows),
  getOcspAllowedPrivateHosts: () => Promise.resolve([]),
}));
vi.mock('../../../services/pki/local-ca-store.js', () => ({
  getLocalContractCa: () => Promise.resolve(state.ca),
}));

import {
  createLocalContractCa,
  issueContractCertificate,
  type LocalContractCa,
} from '../../../services/pki/local-contract-ca.js';
import { certIdFor, parseCertificate } from '../../../services/pki/ocsp.js';
import {
  getLocalMoCertificates,
  localCertificateStatus,
} from '../../../services/pki/local-contract-status.js';

let ca: LocalContractCa;
let contractId: ReturnType<typeof certIdFor>;
let subCa2Id: ReturnType<typeof certIdFor>;

beforeAll(async () => {
  ca = await createLocalContractCa();
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const issued = await issueContractCertificate(ca.iso2, 2, 'USEVTC00000001', keys.publicKey);
  const subCa2 = parseCertificate(ca.iso2.moSubCa2.cert);
  contractId = certIdFor(parseCertificate(issued.certificate), subCa2, 'SHA256');
  subCa2Id = certIdFor(subCa2, parseCertificate(ca.iso2.moSubCa1.cert), 'SHA256');
}, 60_000);

beforeEach(() => {
  state.ca = ca;
  state.rows = [];
});

describe('localCertificateStatus', () => {
  it('is null without a local CA or for a foreign issuer', async () => {
    state.ca = null;
    expect(await getLocalMoCertificates()).toBeNull();
    expect(await localCertificateStatus(contractId)).toBeNull();
    state.ca = ca;
    expect(
      await localCertificateStatus({ ...contractId, issuerKeyHash: '00', issuerNameHash: '00' }),
    ).toBeNull();
  });

  it('follows the contract record for a contract certificate', async () => {
    expect(await localCertificateStatus(contractId)).toBe('unknown');
    state.rows = [{ status: 'active', valid_to: new Date(Date.now() + 60_000) }];
    expect(await localCertificateStatus(contractId)).toBe('good');
    state.rows = [{ status: 'active', valid_to: new Date(Date.now() - 60_000) }];
    expect(await localCertificateStatus(contractId)).toBe('unknown');
    state.rows = [{ status: 'revoked', valid_to: new Date(Date.now() + 60_000) }];
    expect(await localCertificateStatus(contractId)).toBe('revoked');
  });

  it('is good for a local sub-CA and unknown for a serial the CA never issued', async () => {
    expect(await localCertificateStatus(subCa2Id)).toBe('good');
    expect(await localCertificateStatus({ ...subCa2Id, serialNumber: 'abcdef' })).toBe('unknown');
  });

  it('exposes both MO roots and both contract issuers', async () => {
    const local = await getLocalMoCertificates();
    expect(local?.roots).toHaveLength(2);
    expect(local?.contractIssuers).toHaveLength(2);
    expect(local?.all).toHaveLength(6);
  });
});
