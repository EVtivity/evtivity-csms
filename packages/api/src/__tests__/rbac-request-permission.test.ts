// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const { permissionRows } = vi.hoisted(() => ({
  permissionRows: { rows: [] as Array<{ permission: string }> },
}));

vi.mock('@evtivity/database', () => {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(permissionRows.rows),
  };
  return { db: { select: vi.fn(() => chain) }, userPermissions: { userId: 'user_id' } };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn().mockResolvedValue(undefined) }),
}));

import { clearPermissionCacheLocal, requestHasPermission } from '../middleware/rbac.js';

let userSeq = 0;

/** A request authenticated as a fresh user (no cached permissions). */
function requestAs(user: Record<string, unknown>): FastifyRequest {
  return { user } as unknown as FastifyRequest;
}

function freshUserId(): string {
  userSeq += 1;
  const id = `usr_rbac_${String(userSeq)}`;
  clearPermissionCacheLocal(id);
  return id;
}

describe('requestHasPermission', () => {
  beforeEach(() => {
    permissionRows.rows = [];
  });

  it('is true when the user holds the permission', async () => {
    permissionRows.rows = [{ permission: 'payments:read' }, { permission: 'settings.system:read' }];
    const request = requestAs({ userId: freshUserId(), roleId: 'rol_1' });
    expect(await requestHasPermission(request, 'settings.system:read')).toBe(true);
  });

  it('is false when the user does not hold the permission', async () => {
    permissionRows.rows = [{ permission: 'payments:read' }];
    const request = requestAs({ userId: freshUserId(), roleId: 'rol_1' });
    expect(await requestHasPermission(request, 'settings.system:read')).toBe(false);
  });

  it('treats write as implying read, like authorize()', async () => {
    permissionRows.rows = [{ permission: 'settings.system:write' }];
    const request = requestAs({ userId: freshUserId(), roleId: 'rol_1' });
    expect(await requestHasPermission(request, 'settings.system:read')).toBe(true);
  });

  it('is false for an API key whose scope leaves the permission out', async () => {
    permissionRows.rows = [{ permission: 'payments:read' }, { permission: 'settings.system:read' }];
    const request = requestAs({
      userId: freshUserId(),
      roleId: 'rol_1',
      isApiKey: true,
      apiKeyPermissions: ['payments:read'],
    });
    expect(await requestHasPermission(request, 'settings.system:read')).toBe(false);
    expect(await requestHasPermission(request, 'payments:read')).toBe(true);
  });

  it('is true for an API key scoped to a permission the user holds', async () => {
    permissionRows.rows = [{ permission: 'settings.system:read' }];
    const request = requestAs({
      userId: freshUserId(),
      roleId: 'rol_1',
      isApiKey: true,
      apiKeyPermissions: ['settings.system:read'],
    });
    expect(await requestHasPermission(request, 'settings.system:read')).toBe(true);
  });

  it('is false for an API key scope the user does not hold', async () => {
    permissionRows.rows = [{ permission: 'payments:read' }];
    const request = requestAs({
      userId: freshUserId(),
      roleId: 'rol_1',
      isApiKey: true,
      apiKeyPermissions: ['settings.system:read'],
    });
    expect(await requestHasPermission(request, 'settings.system:read')).toBe(false);
  });

  it('is false for a driver token', async () => {
    const request = requestAs({ driverId: 'drv_1' });
    expect(await requestHasPermission(request, 'settings.system:read')).toBe(false);
  });
});
