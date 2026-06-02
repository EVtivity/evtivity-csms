// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { writeAudit, redactAuditPayload } from '../lib/audit.js';

describe('writeAudit', () => {
  it('inserts a row with the expected camelCase column shape for site_id', async () => {
    const insertedValues: unknown[] = [];
    const fakeDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async (v: unknown) => {
          insertedValues.push(v);
        }),
      })),
    };

    await writeAudit(
      // table reference is opaque to the helper -- it just hands it back to drizzle.insert()
      { table: { _: 'siteAuditLog' } as never, idColumn: 'site_id' },
      {
        entityId: 'sit_123',
        entityIdSnapshot: 'sit_123',
        action: 'updated',
        actor: 'operator',
        actorUserId: 'usr_42',
        before: { name: 'Old' },
        after: { name: 'New' },
      },
      fakeDb as never,
    );

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      siteId: 'sit_123',
      siteIdSnapshot: 'sit_123',
      action: 'updated',
      actor: 'operator',
      actorUserId: 'usr_42',
      before: { name: 'Old' },
      after: { name: 'New' },
    });
  });

  it('handles entityId=null for hard-deleted entities', async () => {
    const insertedValues: unknown[] = [];
    const fakeDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async (v: unknown) => {
          insertedValues.push(v);
        }),
      })),
    };

    await writeAudit(
      { table: { _: 'driverAuditLog' } as never, idColumn: 'driver_id' },
      {
        entityId: null,
        entityIdSnapshot: 'drv_gone',
        action: 'deleted',
        actor: 'operator',
        actorUserId: 'usr_1',
        before: { id: 'drv_gone', email: 'gone@example.com' },
      },
      fakeDb as never,
    );

    expect(insertedValues[0]).toMatchObject({
      driverId: null,
      driverIdSnapshot: 'drv_gone',
      action: 'deleted',
      before: { id: 'drv_gone', email: 'gone@example.com' },
      after: null,
    });
  });

  it('converts snake_case idColumn to camelCase field names', async () => {
    const insertedValues: unknown[] = [];
    const fakeDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async (v: unknown) => {
          insertedValues.push(v);
        }),
      })),
    };

    await writeAudit(
      { table: {} as never, idColumn: 'support_case_id' },
      {
        entityId: 'cas_1',
        entityIdSnapshot: 'cas_1',
        action: 'status_changed',
        actor: 'operator',
        actorUserId: 'usr_1',
      },
      fakeDb as never,
    );

    const v = insertedValues[0] as Record<string, unknown>;
    expect(v).toHaveProperty('supportCaseId', 'cas_1');
    expect(v).toHaveProperty('supportCaseIdSnapshot', 'cas_1');
  });

  it('swallows insert errors and warns via the optional logger', async () => {
    const fakeDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw new Error('connection lost');
        }),
      })),
    };
    const warn = vi.fn();
    const logger = { warn };

    await expect(
      writeAudit(
        { table: {} as never, idColumn: 'site_id' },
        {
          entityId: 'sit_1',
          entityIdSnapshot: 'sit_1',
          action: 'updated',
          actor: 'system',
        },
        fakeDb as never,
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('audit insert failed');
  });

  it('redacts sensitive fields like passwordHash from before/after JSONB', async () => {
    const insertedValues: unknown[] = [];
    const fakeDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async (v: unknown) => {
          insertedValues.push(v);
        }),
      })),
    };

    await writeAudit(
      { table: {} as never, idColumn: 'driver_id' },
      {
        entityId: 'drv_1',
        entityIdSnapshot: 'drv_1',
        action: 'created',
        actor: 'operator',
        after: {
          id: 'drv_1',
          email: 'driver@example.com',
          passwordHash: '$argon2id$v=19$...secret-hash',
          totpSecretEnc: 'enc-totp-blob',
          mfaSecret: 'plain-mfa',
        },
      },
      fakeDb as never,
    );

    const v = insertedValues[0] as Record<string, unknown>;
    const after = v['after'] as Record<string, unknown>;
    expect(after['passwordHash']).toBe('<redacted>');
    expect(after['totpSecretEnc']).toBe('<redacted>');
    expect(after['mfaSecret']).toBe('<redacted>');
    expect(after['email']).toBe('driver@example.com');
  });

  it('redactAuditPayload recurses into nested objects', () => {
    const out = redactAuditPayload({
      driver: { id: 'drv_1', passwordHash: 'h1' },
      meta: { tokenHash: 'th', other: 'safe' },
    }) as Record<string, Record<string, unknown>>;
    expect(out['driver']?.['passwordHash']).toBe('<redacted>');
    expect(out['meta']?.['tokenHash']).toBe('<redacted>');
    expect(out['meta']?.['other']).toBe('safe');
  });

  it('redactAuditPayload recurses into arrays of objects', () => {
    const out = redactAuditPayload({
      tokens: [
        { id: 't1', tokenHash: 'h1', label: 'main' },
        { id: 't2', tokenHash: 'h2', label: 'backup' },
      ],
      certs: [{ clientCert: 'PEM', clientKey: 'KEY' }],
    }) as Record<string, Array<Record<string, unknown>>>;
    expect(out['tokens']?.[0]?.['tokenHash']).toBe('<redacted>');
    expect(out['tokens']?.[0]?.['label']).toBe('main');
    expect(out['tokens']?.[1]?.['tokenHash']).toBe('<redacted>');
    expect(out['certs']?.[0]?.['clientCert']).toBe('<redacted>');
    expect(out['certs']?.[0]?.['clientKey']).toBe('<redacted>');
  });

  it('null-defaults all optional actor and snapshot fields', async () => {
    const insertedValues: unknown[] = [];
    const fakeDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async (v: unknown) => {
          insertedValues.push(v);
        }),
      })),
    };

    await writeAudit(
      { table: {} as never, idColumn: 'fleet_id' },
      {
        entityId: 'flt_1',
        entityIdSnapshot: 'flt_1',
        action: 'created',
        actor: 'operator',
      },
      fakeDb as never,
    );

    const v = insertedValues[0] as Record<string, unknown>;
    expect(v['actorUserId']).toBeNull();
    expect(v['actorDriverId']).toBeNull();
    expect(v['actorApiKeyId']).toBeNull();
    expect(v['actorLabel']).toBeNull();
    expect(v['before']).toBeNull();
    expect(v['after']).toBeNull();
    expect(v['notes']).toBeNull();
  });
});
