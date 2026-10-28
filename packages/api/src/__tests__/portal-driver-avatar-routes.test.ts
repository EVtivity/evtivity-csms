// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'set', 'returning', 'update']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  db: {
    select: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  drivers: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), sql: vi.fn() }));

const { s3Mock, requestUploadMock, setGeneratedMock, confirmMock, removeMock, viewMock } =
  vi.hoisted(() => ({
    s3Mock: vi.fn(),
    requestUploadMock: vi.fn(),
    setGeneratedMock: vi.fn(),
    confirmMock: vi.fn(),
    removeMock: vi.fn(),
    viewMock: vi.fn(),
  }));

vi.mock('../services/storage.service.js', () => ({ getObjectStorage: s3Mock }));
vi.mock('../services/account-avatar-upload.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/account-avatar-upload.js')>()),
  requestAvatarUpload: requestUploadMock,
}));
vi.mock('../services/account-avatar.js', () => ({ avatarView: viewMock }));
vi.mock('../services/driver-avatar.service.js', () => ({
  driverAvatarColumns: {},
  setGeneratedAvatar: setGeneratedMock,
  confirmUploadedAvatar: confirmMock,
  removeAvatar: removeMock,
}));

import rateLimit from '@fastify/rate-limit';
import { registerAuth } from '../plugins/auth.js';
import { portalDriverAvatarRoutes } from '../routes/portal/driver-avatar.js';

const DRIVER_ID = 'drv_000000000001';
const S3 = { bucket: 'b' };
const GENERATED = { style: 'avataaars', seed: 'abc', options: { topVariant: 'bob' } };
const GENERATED_VIEW = { kind: 'generated', updatedAt: null, ...GENERATED };

describe('Portal driver avatar routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest('responseCacheUnchanged', false);
    app.addHook('onSend', async (request, reply) => {
      reply.header('x-unchanged', String(request.responseCacheUnchanged));
    });
    await registerAuth(app);
    await app.register(portalDriverAvatarRoutes, { prefix: '/v1' });
    await app.ready();
    token = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
    s3Mock.mockResolvedValue(S3);
    viewMock.mockResolvedValue(GENERATED_VIEW);
  });

  function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  }

  it('refuses a request without a driver token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/portal/driver/avatar' });
    expect(res.statusCode).toBe(401);
  });

  it('GET returns the avatar view of the caller', async () => {
    dbResults = [[{ avatarKind: 'generated' }]];
    const res = await call('GET', '/v1/portal/driver/avatar');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ avatar: GENERATED_VIEW });
    expect(s3Mock).not.toHaveBeenCalled();
  });

  it('PUT stores a generated avatar for the caller', async () => {
    setGeneratedMock.mockResolvedValue({ avatar: { avatarKind: 'generated' }, changed: true });
    const res = await call('PUT', '/v1/portal/driver/avatar', GENERATED);
    expect(res.statusCode).toBe(200);
    expect(setGeneratedMock).toHaveBeenCalledWith(
      DRIVER_ID,
      GENERATED,
      expect.objectContaining({ actor: expect.objectContaining({ actorDriverId: DRIVER_ID }) }),
    );
    expect(res.json()).toEqual({ avatar: GENERATED_VIEW });
    expect(res.headers['x-unchanged']).toBe('false');
  });

  it('PUT of the same avatar marks the request unchanged, so no cache tag is bumped (L2)', async () => {
    setGeneratedMock.mockResolvedValue({ avatar: { avatarKind: 'generated' }, changed: false });
    const res = await call('PUT', '/v1/portal/driver/avatar', GENERATED);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-unchanged']).toBe('true');
  });

  it('PUT refuses another style by schema', async () => {
    const res = await call('PUT', '/v1/portal/driver/avatar', { ...GENERATED, style: 'bottts' });
    expect(res.statusCode).toBe(400);
    expect(setGeneratedMock).not.toHaveBeenCalled();
  });

  it('upload-url issues a POST into the caller prefix', async () => {
    requestUploadMock.mockResolvedValue({ uploadUrl: 'u', fields: {}, s3Key: 'k', s3Bucket: 'b' });
    const res = await call('POST', '/v1/portal/driver/avatar/upload-url', {
      fileName: 'me.png',
      contentType: 'image/png',
      fileSize: 1024 * 1024 - 1,
    });
    expect(res.statusCode).toBe(200);
    expect(requestUploadMock).toHaveBeenCalledWith(
      S3,
      { kind: 'driver', driverId: DRIVER_ID },
      'image/png',
    );
  });

  it('upload-url refuses exactly 1 MiB with AI_ATTACHMENT_TOO_LARGE', async () => {
    const res = await call('POST', '/v1/portal/driver/avatar/upload-url', {
      fileName: 'me.png',
      contentType: 'image/png',
      fileSize: 1024 * 1024,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'AI_ATTACHMENT_TOO_LARGE' });
    expect(requestUploadMock).not.toHaveBeenCalled();
  });

  it.each(['image/svg+xml', 'image/gif', 'application/pdf'])(
    'upload-url refuses %s',
    async (contentType) => {
      const res = await call('POST', '/v1/portal/driver/avatar/upload-url', {
        fileName: 'x',
        contentType,
        fileSize: 10,
      });
      expect(res.statusCode).toBe(400);
      expect(requestUploadMock).not.toHaveBeenCalled();
    },
  );

  it('upload-url and image answer STORAGE_NOT_CONFIGURED without S3', async () => {
    s3Mock.mockResolvedValue(null);
    const upload = await call('POST', '/v1/portal/driver/avatar/upload-url', {
      fileName: 'me.jpg',
      contentType: 'image/jpeg',
      fileSize: 10,
    });
    expect(upload.json()).toMatchObject({ code: 'STORAGE_NOT_CONFIGURED' });
    const image = await call('POST', '/v1/portal/driver/avatar/image', {
      s3Key: 'k',
      s3Bucket: 'b',
    });
    expect(image.statusCode).toBe(400);
    expect(image.json()).toMatchObject({ code: 'STORAGE_NOT_CONFIGURED' });
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('image confirms through the service for the caller', async () => {
    confirmMock.mockResolvedValue({ avatarKind: 'image' });
    viewMock.mockResolvedValue({
      kind: 'image',
      url: 'https://s3/x',
      expiresAt: null,
      updatedAt: null,
    });
    const res = await call('POST', '/v1/portal/driver/avatar/image', { s3Key: 'k', s3Bucket: 'b' });
    expect(res.statusCode).toBe(200);
    expect(confirmMock).toHaveBeenCalledWith(
      DRIVER_ID,
      S3,
      { s3Key: 'k', s3Bucket: 'b' },
      expect.anything(),
    );
    expect(res.json()).toMatchObject({ avatar: { kind: 'image', url: 'https://s3/x' } });
  });

  it('DELETE removes the avatar', async () => {
    removeMock.mockResolvedValue(true);
    const res = await call('DELETE', '/v1/portal/driver/avatar');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ avatar: null });
    expect(removeMock).toHaveBeenCalledWith(DRIVER_ID, expect.anything());
    expect(res.headers['x-unchanged']).toBe('false');
  });

  it('DELETE without an avatar marks the request unchanged', async () => {
    removeMock.mockResolvedValue(false);
    const res = await call('DELETE', '/v1/portal/driver/avatar');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-unchanged']).toBe('true');
  });

  it('limits PUT and DELETE to 20 a minute per driver (L2)', async () => {
    const other = app.jwt.sign({ driverId: 'drv_000000000099', type: 'driver' });
    const fresh = app.jwt.sign({ driverId: 'drv_000000000098', type: 'driver' });
    setGeneratedMock.mockResolvedValue({ avatar: { avatarKind: 'generated' }, changed: true });
    removeMock.mockResolvedValue(true);
    for (const method of ['PUT', 'DELETE'] as const) {
      const payload = method === 'PUT' ? GENERATED : undefined;
      const codes: number[] = [];
      for (let i = 0; i < 21; i++) {
        const res = await app.inject({
          method,
          url: '/v1/portal/driver/avatar',
          headers: { authorization: `Bearer ${fresh}` },
          ...(payload !== undefined ? { payload } : {}),
        });
        codes.push(res.statusCode);
      }
      expect(
        codes.slice(0, 20).every((code) => code === 200),
        method,
      ).toBe(true);
      expect(codes[20], method).toBe(429);
      // Another driver keeps its own budget.
      const res = await app.inject({
        method,
        url: '/v1/portal/driver/avatar',
        headers: { authorization: `Bearer ${other}` },
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, method).toBe(200);
    }
  });
});
