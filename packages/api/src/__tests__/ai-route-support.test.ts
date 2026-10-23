// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerAuthorization } from '../services/ai/engine/route-support.js';

const SECRET = 'test-cookie-secret-0123456789abcdef';

describe('callerAuthorization', () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(fastifyCookie, { secret: SECRET });
    app.get('/who', (request) => ({ authorization: callerAuthorization(request) }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function authorizationFor(headers: Record<string, string>): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/who', headers });
    return res.json<{ authorization: string }>().authorization;
  }

  it('uses the Authorization header first', async () => {
    const signed = app.signCookie('jwt-from-cookie');
    expect(
      await authorizationFor({
        authorization: 'Bearer header-jwt',
        cookie: `csms_token=${signed}`,
      }),
    ).toBe('Bearer header-jwt');
  });

  it('turns a signed csms_token into a bearer token', async () => {
    const signed = app.signCookie('jwt-from-cookie');
    expect(await authorizationFor({ cookie: `csms_token=${encodeURIComponent(signed)}` })).toBe(
      'Bearer jwt-from-cookie',
    );
  });

  it('gives no authorization for an unsigned or forged csms_token', async () => {
    expect(await authorizationFor({ cookie: 'csms_token=raw-unsigned-jwt' })).toBe('');
    expect(await authorizationFor({ cookie: 'csms_token=raw-jwt.forgedsignature' })).toBe('');
  });

  it('gives no authorization without a header or cookie', async () => {
    expect(await authorizationFor({})).toBe('');
  });
});
