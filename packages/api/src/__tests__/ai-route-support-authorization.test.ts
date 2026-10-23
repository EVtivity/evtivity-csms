// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

vi.mock('@evtivity/database', () => ({ getAiSettings: vi.fn() }));
vi.mock('../services/ai/conversation.service.js', () => ({
  claimTurn: vi.fn(),
  releaseTurn: vi.fn(),
}));

import { callerAuthorization } from '../services/ai/engine/route-support.js';

function request(opts: {
  authorization?: string;
  cookie?: string;
  valid?: boolean;
}): FastifyRequest {
  return {
    headers: opts.authorization != null ? { authorization: opts.authorization } : {},
    cookies: opts.cookie != null ? { csms_token: opts.cookie } : {},
    unsignCookie: (raw: string) =>
      opts.valid === true
        ? { valid: true, renew: false, value: raw.replace(/\.sig$/, '') }
        : { valid: false, renew: false, value: null },
  } as unknown as FastifyRequest;
}

describe('callerAuthorization', () => {
  it("forwards the request's own Authorization header", () => {
    expect(callerAuthorization(request({ authorization: 'Bearer key_1', cookie: 'x' }))).toBe(
      'Bearer key_1',
    );
  });

  it('forwards a signed session cookie as a bearer token', () => {
    expect(callerAuthorization(request({ cookie: 'jwt-value.sig', valid: true }))).toBe(
      'Bearer jwt-value',
    );
  });

  it('forwards nothing for a cookie whose signature does not verify', () => {
    expect(callerAuthorization(request({ cookie: 'forged-jwt', valid: false }))).toBe('');
  });

  it('forwards nothing without a header or a cookie', () => {
    expect(callerAuthorization(request({}))).toBe('');
  });
});
