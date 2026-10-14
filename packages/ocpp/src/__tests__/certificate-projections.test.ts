// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { handleCsrSigned } = await import('../services/pki/certificate-projections.js');

const payload = {
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
      },
    });
  });

  it('labels the default provider manual when pnc.provider is unset', async () => {
    await handleCsrSigned(makeSql([{ id: 7 }], null), 'CS-1', 'sta-uuid', payload, pubsub);
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({ actorLabel: 'pki:manual' });
  });

  it('writes no audit row when no pending CSR was updated', async () => {
    await handleCsrSigned(makeSql([]), 'CS-1', 'sta-uuid', payload, pubsub);
    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockPublishOcppCommand).toHaveBeenCalled();
  });
});
