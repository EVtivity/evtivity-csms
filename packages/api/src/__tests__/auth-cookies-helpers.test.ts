// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

const configState = vi.hoisted(() => ({ COOKIE_DOMAIN: undefined as string | undefined }));

vi.mock('../lib/config.js', () => ({
  config: configState,
}));

import { isSecureRequest, setAuthCookies, clearAuthCookies } from '../lib/auth-cookies.js';

const AGES = { accessSeconds: 3600, refreshSeconds: 30 * 24 * 60 * 60 };

beforeEach(() => {
  configState.COOKIE_DOMAIN = undefined;
});

describe('isSecureRequest', () => {
  async function secureFor(
    trustProxy: string | false,
    headers: Record<string, string>,
  ): Promise<boolean> {
    const app = Fastify({ trustProxy });
    app.get('/', (request) => ({ secure: isSecureRequest(request) }));
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers,
      remoteAddress: '203.0.113.9',
    });
    await app.close();
    return res.json<{ secure: boolean }>().secure;
  }

  it('ignores a forged X-Forwarded-Proto from a peer that is not a trusted proxy', async () => {
    expect(await secureFor(false, { 'x-forwarded-proto': 'https' })).toBe(false);
    expect(await secureFor('10.0.0.0/8', { 'x-forwarded-proto': 'https' })).toBe(false);
  });

  it('follows X-Forwarded-Proto from a trusted proxy', async () => {
    expect(await secureFor('203.0.113.0/24', { 'x-forwarded-proto': 'https' })).toBe(true);
    expect(await secureFor('203.0.113.0/24', { 'x-forwarded-proto': 'http' })).toBe(false);
  });

  it('reads request.protocol', () => {
    const reqHttps = { headers: {}, protocol: 'https' } as unknown as FastifyRequest;
    expect(isSecureRequest(reqHttps)).toBe(true);
    const forged = {
      headers: { 'x-forwarded-proto': 'https' },
      protocol: 'http',
    } as unknown as FastifyRequest;
    expect(isSecureRequest(forged)).toBe(false);
  });
});

describe('setAuthCookies / clearAuthCookies COOKIE_DOMAIN handling', () => {
  function makeReply(): {
    reply: FastifyReply;
    setCookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  } {
    const setCookie = vi.fn();
    const clearCookie = vi.fn();
    const reply = { setCookie, clearCookie } as unknown as FastifyReply;
    return { reply, setCookie, clearCookie };
  }

  it('does not include a domain option when COOKIE_DOMAIN is unset', () => {
    const { reply, setCookie } = makeReply();
    setAuthCookies('csms', reply, 'access', 'refresh', true, AGES);

    expect(setCookie).toHaveBeenCalledTimes(3);
    for (const call of setCookie.mock.calls) {
      expect(call[2]).not.toHaveProperty('domain');
    }
  });

  it('includes the configured domain on every cookie when COOKIE_DOMAIN is set', () => {
    configState.COOKIE_DOMAIN = '.evtivity.com';
    const { reply, setCookie } = makeReply();
    setAuthCookies('portal', reply, 'access', 'refresh', false, AGES);

    expect(setCookie).toHaveBeenCalledTimes(3);
    for (const call of setCookie.mock.calls) {
      expect(call[2]).toMatchObject({ domain: '.evtivity.com' });
    }

    // Token cookie uses the portal path; refresh and csrf use '/'.
    const tokenCall = setCookie.mock.calls.find((c) => c[0] === 'portal_token');
    expect(tokenCall?.[2]).toMatchObject({
      httpOnly: true,
      secure: false,
      path: '/v1/portal',
    });
  });

  it('sets the access and CSRF cookies to the access age and the refresh cookie to the refresh age', () => {
    const { reply, setCookie } = makeReply();
    setAuthCookies('csms', reply, 'access', 'refresh', true, {
      accessSeconds: 900,
      refreshSeconds: 7 * 24 * 60 * 60,
    });
    const ageOf = (name: string): unknown =>
      (setCookie.mock.calls.find((c) => c[0] === name)?.[2] as { maxAge?: number }).maxAge;
    expect(ageOf('csms_token')).toBe(900);
    expect(ageOf('csms_csrf')).toBe(900);
    expect(ageOf('csms_refresh')).toBe(7 * 24 * 60 * 60);
  });

  it('clearAuthCookies includes the domain when COOKIE_DOMAIN is set', () => {
    configState.COOKIE_DOMAIN = '.evtivity.com';
    const { reply, clearCookie } = makeReply();
    clearAuthCookies('csms', reply, true);

    expect(clearCookie).toHaveBeenCalledTimes(3);
    for (const call of clearCookie.mock.calls) {
      expect(call[1]).toMatchObject({ domain: '.evtivity.com' });
    }
  });

  it('clearAuthCookies omits the domain when COOKIE_DOMAIN is unset', () => {
    const { reply, clearCookie } = makeReply();
    clearAuthCookies('portal', reply, false);
    for (const call of clearCookie.mock.calls) {
      expect(call[1]).not.toHaveProperty('domain');
    }
  });
});
