// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const {
  mockSelectWhere,
  mockUpserts,
  mockWriteAudit,
  mockClearPaymentCaches,
  mockTransaction,
  mockAssertWritable,
} = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockUpserts: [] as Array<{ key: string; value: unknown }>,
  mockWriteAudit: vi.fn(),
  mockClearPaymentCaches: vi.fn(),
  mockTransaction: vi.fn(),
  mockAssertWritable: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const insertChain = (target: string) => ({
    values: (row: { key: string; value: unknown }) => ({
      onConflictDoUpdate: () => {
        if (target === 'fail') return Promise.reject(new Error('db down'));
        mockUpserts.push(row);
        return Promise.resolve();
      },
    }),
  });
  const tx = { insert: () => insertChain('ok') };
  return {
    db: {
      select: () => ({ from: () => ({ where: mockSelectWhere }) }),
      transaction: mockTransaction.mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      ),
    },
    settings: { key: 'key' },
    settingAuditLog: { name: 'setting_audit_log' },
    writeAudit: mockWriteAudit,
  };
});

vi.mock('drizzle-orm', () => ({ inArray: vi.fn() }));

vi.mock('../lib/payments.js', () => ({ clearPaymentCaches: mockClearPaymentCaches }));

vi.mock('../lib/provider-switch.js', () => ({
  assertPaymentProviderWritable: mockAssertWritable,
}));

vi.mock('../lib/audit-actor.js', () => ({
  getAuditActor: () => ({
    actor: 'user',
    actorUserId: 'usr_000000000001',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  }),
}));

import { writePaymentSettings } from '../lib/payment-settings-writes.js';

const request = { log: { warn: vi.fn(), error: vi.fn() } } as unknown as FastifyRequest;

describe('writePaymentSettings', () => {
  beforeEach(() => {
    mockUpserts.length = 0;
    mockWriteAudit.mockResolvedValue(undefined);
    mockAssertWritable.mockResolvedValue(undefined);
  });

  it('runs the provider-switch guard on every pair before writing', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    await writePaymentSettings(request, [
      { key: 'payments.provider', value: 'adyen' },
      { key: 'stripe.publishableKey', value: 'pk_new' },
    ]);
    expect(mockAssertWritable.mock.calls).toEqual([
      ['payments.provider', 'adyen'],
      ['stripe.publishableKey', 'pk_new'],
    ]);
    expect(mockUpserts).toHaveLength(2);
  });

  it('writes nothing when the guard refuses the provider', async () => {
    mockAssertWritable.mockRejectedValueOnce(new Error('upgrade pending'));
    await expect(
      writePaymentSettings(request, [{ key: 'payments.provider', value: 'adyen' }]),
    ).rejects.toThrow('upgrade pending');
    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockClearPaymentCaches).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('upserts every pair in one transaction and clears the payment caches', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);

    await writePaymentSettings(request, [
      { key: 'stripe.webhookSecretEnc', value: 'cipher_1' },
      { key: 'stripe.connectWebhookSecretEnc', value: 'cipher_2' },
    ]);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpserts).toEqual([
      { key: 'stripe.webhookSecretEnc', value: 'cipher_1' },
      { key: 'stripe.connectWebhookSecretEnc', value: 'cipher_2' },
    ]);
    expect(mockClearPaymentCaches).toHaveBeenCalledTimes(1);
  });

  it('audits changed keys with before and after, and skips unchanged ones', async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { key: 'stripe.preAuthAmountCents', value: 5000 },
      { key: 'stripe.publishableKey', value: 'pk_old' },
    ]);

    await writePaymentSettings(request, [
      { key: 'stripe.preAuthAmountCents', value: 5000 },
      { key: 'stripe.publishableKey', value: 'pk_new' },
      { key: 'stripe.platformFeePercent', value: 2 },
    ]);

    expect(mockWriteAudit).toHaveBeenCalledTimes(2);
    const audited = mockWriteAudit.mock.calls.map(
      (call) => (call[1] as { entityId: string }).entityId,
    );
    expect(audited).toEqual(['stripe.publishableKey', 'stripe.platformFeePercent']);
    expect(mockWriteAudit.mock.calls[0]?.[0]).toEqual({
      table: { name: 'setting_audit_log' },
      idColumn: 'setting_key',
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'stripe.publishableKey',
      entityIdSnapshot: 'stripe.publishableKey',
      action: 'updated',
      actor: 'user',
      actorUserId: 'usr_000000000001',
      before: { key: 'stripe.publishableKey', value: 'pk_old' },
      after: { key: 'stripe.publishableKey', value: 'pk_new' },
    });
    expect(mockWriteAudit.mock.calls[1]?.[1]).toMatchObject({
      before: { key: 'stripe.platformFeePercent', value: undefined },
      after: { key: 'stripe.platformFeePercent', value: 2 },
    });
  });

  it('keeps the write when an audit insert fails (fail-open, P9)', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    mockWriteAudit.mockRejectedValueOnce(new Error('audit down'));

    await expect(
      writePaymentSettings(request, [{ key: 'stripe.publishableKey', value: 'pk_new' }]),
    ).resolves.toBeUndefined();
    expect(mockUpserts).toHaveLength(1);
  });

  it('does nothing for an empty list except clearing the caches', async () => {
    await writePaymentSettings(request, []);
    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockClearPaymentCaches).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed write and does not audit it', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    mockTransaction.mockImplementationOnce(() => Promise.reject(new Error('db down')));

    await expect(
      writePaymentSettings(request, [{ key: 'stripe.publishableKey', value: 'pk_new' }]),
    ).rejects.toThrow('db down');
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});
