// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import type postgres from 'postgres';
import type { PubSubClient } from '@evtivity/lib';

const { mockWriteAudit, mockPublishOcppCommand } = vi.hoisted(() => ({
  mockWriteAudit: vi.fn(),
  mockPublishOcppCommand: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  certificateAuditLog: 'certificate_audit_log',
  writeAudit: mockWriteAudit,
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  publishOcppCommand: mockPublishOcppCommand,
}));

const { handleCsrSigned, handleCertificateSignedResult } =
  await import('../services/pki/certificate-projections.js');

const payload = {
  csrId: 42,
  requestId: 7,
  certificateChain: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
  certificateType: 'ChargingStationCertificate',
  providerReference: 'hub-ref-1',
};

function makeSql(signedRows: unknown[], provider: string | null = 'hubject'): postgres.Sql {
  return vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('UPDATE pki_csr_requests')) return Promise.resolve(signedRows);
    if (text.includes("key = 'pnc.provider'")) {
      return Promise.resolve(provider == null ? [] : [{ value: provider }]);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
}

const pubsub = {} as PubSubClient;

describe('handleCsrSigned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishOcppCommand.mockResolvedValue(undefined);
  });

  it('audits the signed CSR as a system row labeled with the PKI provider, without the chain', async () => {
    await handleCsrSigned(makeSql([{ id: 42 }]), 'CS-1', 'sta-uuid', payload, pubsub);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      { table: 'certificate_audit_log', idColumn: 'certificate_id' },
      {
        entityId: '42',
        entityIdSnapshot: '42',
        action: 'csr_signed',
        actor: 'system',
        actorLabel: 'pki:hubject',
        after: {
          status: 'signed',
          stationId: 'sta-uuid',
          certificateType: 'ChargingStationCertificate',
          providerReference: 'hub-ref-1',
        },
      },
      undefined,
      expect.anything(),
    );
    expect(JSON.stringify(mockWriteAudit.mock.calls[0])).not.toContain('BEGIN CERTIFICATE');
    expect(mockPublishOcppCommand).toHaveBeenCalledWith(pubsub, {
      stationId: 'CS-1',
      action: 'CertificateSigned',
      payload: {
        certificateChain: payload.certificateChain,
        certificateType: 'ChargingStationCertificate',
        requestId: 7,
      },
    });
  });

  it('updates only the CSR the event names, while it is open', async () => {
    const sql = makeSql([{ id: 42 }]);
    await handleCsrSigned(sql, 'CS-1', 'sta-uuid', payload, pubsub);
    const calls = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const call = calls.find((c) =>
      (c[0] as string[]).join('?').includes('UPDATE pki_csr_requests'),
    );
    const text = (call?.[0] as string[]).join('?');
    expect(text).toContain('WHERE id = ?');
    expect(text).toContain("status IN ('pending', 'submitted')");
    expect(call).toContain(42);
  });

  it('omits requestId when the station sent none', async () => {
    await handleCsrSigned(
      makeSql([{ id: 42 }]),
      'CS-1',
      'sta-uuid',
      { ...payload, requestId: null },
      pubsub,
    );
    expect(mockPublishOcppCommand.mock.calls[0]?.[1]).toMatchObject({
      payload: { certificateChain: payload.certificateChain },
    });
    expect(
      (mockPublishOcppCommand.mock.calls[0]?.[1] as { payload: Record<string, unknown> }).payload,
    ).not.toHaveProperty('requestId');
  });

  it('labels the default provider manual when pnc.provider is unset', async () => {
    await handleCsrSigned(makeSql([{ id: 7 }], null), 'CS-1', 'sta-uuid', payload, pubsub);
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({ actorLabel: 'pki:manual' });
  });

  it('sends nothing again when the CSR is no longer open (replayed event)', async () => {
    await handleCsrSigned(makeSql([]), 'CS-1', 'sta-uuid', payload, pubsub);
    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockPublishOcppCommand).not.toHaveBeenCalled();
  });
});

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

async function selfSigned(cn: string): Promise<string> {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '0a1b2c',
    name: `CN=${cn}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    keys,
    signingAlgorithm: alg,
  });
  return cert.toString('pem');
}

function makeTxSql(existing: unknown[]): {
  sql: postgres.Sql;
  statements: Array<{ text: string; values: unknown[] }>;
} {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('SELECT id FROM station_certificates')) return Promise.resolve(existing);
    if (text.includes('INSERT INTO station_certificates')) return Promise.resolve([{ id: 99 }]);
    return Promise.resolve([]);
  });
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  }) as unknown as postgres.Sql;
  return { sql, statements };
}

describe('handleCertificateSignedResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores the accepted leaf with its serial and validity and audits it', async () => {
    const leaf = await selfSigned('CS-1');
    const chain = `${leaf}\n${await selfSigned('Sub CA')}`;
    const { sql, statements } = makeTxSql([]);
    await handleCertificateSignedResult(
      sql,
      'sta-uuid',
      chain,
      'ChargingStationCertificate',
      'Accepted',
    );
    const insert = statements.find((s) => s.text.includes('INSERT INTO station_certificates'));
    expect(insert).toBeDefined();
    expect(insert?.values).toContain('sta-uuid');
    expect(insert?.values).toContain('ChargingStationCertificate');
    expect(insert?.values).toContain(leaf);
    expect(insert?.values).toContain('0A1B2C');
    // Only the leaf, and the previous certificate is kept (A02.FR.28 fallback).
    expect(statements.filter((s) => s.text.includes('INSERT'))).toHaveLength(1);
    expect(statements.some((s) => s.text.includes('DELETE'))).toBe(false);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      { table: 'certificate_audit_log', idColumn: 'certificate_id' },
      expect.objectContaining({
        entityId: '99',
        action: 'certificate_installed',
        actor: 'system',
      }),
      undefined,
      expect.anything(),
    );
  });

  it('changes nothing when the station rejected the chain', async () => {
    const { sql, statements } = makeTxSql([]);
    await handleCertificateSignedResult(
      sql,
      'sta-uuid',
      await selfSigned('CS-1'),
      'V2GCertificate',
      'Rejected',
    );
    expect(statements).toHaveLength(0);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('stores a certificate once when the result is replayed', async () => {
    const { sql, statements } = makeTxSql([{ id: 5 }]);
    await handleCertificateSignedResult(
      sql,
      'sta-uuid',
      await selfSigned('CS-1'),
      'ChargingStationCertificate',
      'Accepted',
    );
    expect(statements.some((s) => s.text.includes('INSERT'))).toBe(false);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('ignores a chain that does not parse', async () => {
    const { sql, statements } = makeTxSql([]);
    await handleCertificateSignedResult(
      sql,
      'sta-uuid',
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
      'ChargingStationCertificate',
      'Accepted',
    );
    expect(statements).toHaveLength(0);
  });
});
