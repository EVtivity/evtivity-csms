// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const { permissionRows, dbSelect, publish } = vi.hoisted(() => ({
  permissionRows: { rows: [] as Array<{ permission: string }> },
  dbSelect: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(permissionRows.rows),
  };
  dbSelect.mockImplementation(() => chain);
  return { db: { select: dbSelect }, userPermissions: { userId: 'user_id' } };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish }),
}));

import {
  authorize,
  clearPermissionCacheLocal,
  invalidatePermissionCache,
  requestHasPermission,
} from '../middleware/rbac.js';

let seq = 0;
function freshUserId(): string {
  seq += 1;
  const id = `usr_cov2_${String(seq)}`;
  clearPermissionCacheLocal(id);
  return id;
}

interface FakeReply {
  sent: boolean;
  statusCode: number | null;
  body: unknown;
  status: (code: number) => FakeReply;
  send: (body: unknown) => Promise<void>;
}

function fakeReply(): FakeReply {
  const reply: FakeReply = {
    sent: false,
    statusCode: null,
    body: undefined,
    status(code) {
      reply.statusCode = code;
      return reply;
    },
    send(body) {
      reply.body = body;
      reply.sent = true;
      return Promise.resolve();
    },
  };
  return reply;
}

function fakeRequest(
  user: Record<string, unknown>,
  authenticate: (req: FastifyRequest, reply: FakeReply) => Promise<void> = () => Promise.resolve(),
): FastifyRequest {
  return { user, server: { authenticate } } as unknown as FastifyRequest;
}

async function run(guard: ReturnType<typeof authorize>, req: FastifyRequest): Promise<FakeReply> {
  const reply = fakeReply();
  await guard(req, reply as unknown as FastifyReply);
  return reply;
}

const DENIED = { error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' };

describe('authorize', () => {
  beforeEach(() => {
    permissionRows.rows = [];
    publish.mockReset().mockResolvedValue(undefined);
  });

  it('stops when authentication already replied', async () => {
    const req = fakeRequest({ userId: freshUserId() }, (_r, reply) =>
      reply.status(401).send({ error: 'Unauthorized' }),
    );
    const reply = await run(authorize('stations:read'), req);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized' });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('lets any authenticated caller through when no permission is required', async () => {
    const reply = await run(authorize(), fakeRequest({ driverId: 'drv_1' }));
    expect(reply.sent).toBe(false);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('refuses a token without a userId (driver token) with 403', async () => {
    const reply = await run(authorize('stations:read'), fakeRequest({ driverId: 'drv_1' }));
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual(DENIED);
  });

  it('refuses a user missing one of the required permissions', async () => {
    permissionRows.rows = [{ permission: 'stations:read' }];
    const reply = await run(
      authorize('stations:read', 'sites:write'),
      fakeRequest({ userId: freshUserId() }),
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual(DENIED);
  });

  it('passes a user holding every required permission (write implies read)', async () => {
    permissionRows.rows = [{ permission: 'stations:write' }, { permission: 'sites:write' }];
    const reply = await run(
      authorize('stations:read', 'sites:write'),
      fakeRequest({ userId: freshUserId() }),
    );
    expect(reply.sent).toBe(false);
  });

  it('limits an API key to its scope even when the user holds more', async () => {
    permissionRows.rows = [{ permission: 'stations:write' }, { permission: 'sites:write' }];
    const reply = await run(
      authorize('sites:write'),
      fakeRequest({ userId: freshUserId(), apiKeyPermissions: ['stations:write'] }),
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual(DENIED);
  });
});

describe('invalidatePermissionCache', () => {
  beforeEach(() => {
    permissionRows.rows = [];
    publish.mockReset().mockResolvedValue(undefined);
  });

  it('broadcasts the invalidation and drops the local entry', async () => {
    const userId = freshUserId();
    permissionRows.rows = [{ permission: 'stations:read' }];
    const req = { user: { userId } } as unknown as FastifyRequest;
    expect(await requestHasPermission(req, 'stations:read')).toBe(true);

    // Cached: a changed DB row is not seen yet.
    permissionRows.rows = [];
    expect(await requestHasPermission(req, 'stations:read')).toBe(true);

    invalidatePermissionCache(userId);
    expect(publish).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ kind: 'permission', userId }),
    );
    expect(await requestHasPermission(req, 'stations:read')).toBe(false);
  });

  it('swallows a failed broadcast (best effort)', async () => {
    publish.mockRejectedValueOnce(new Error('redis down'));
    const userId = freshUserId();
    expect(() => {
      invalidatePermissionCache(userId);
    }).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publish).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ kind: 'permission', userId }),
    );
  });
});
