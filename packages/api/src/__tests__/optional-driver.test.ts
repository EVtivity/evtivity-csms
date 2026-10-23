// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const rejection = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('../plugins/auth.js', () => ({
  driverTokenRejection: vi.fn(() => Promise.resolve(rejection.value)),
}));

import { optionalDriverId } from '../lib/optional-driver.js';

function requestWith(payload: Record<string, unknown> | null): FastifyRequest {
  return {
    jwtVerify: () =>
      payload == null ? Promise.reject(new Error('no token')) : Promise.resolve(payload),
  } as unknown as FastifyRequest;
}

beforeEach(() => {
  rejection.value = null;
});

describe('optionalDriverId', () => {
  it('answers the driver of a token authenticateDriver accepts', async () => {
    expect(await optionalDriverId(requestWith({ type: 'driver', driverId: 'drv_1', sv: 0 }))).toBe(
      'drv_1',
    );
  });

  it('treats a token of an ended session or a deactivated driver as anonymous', async () => {
    rejection.value = { status: 401, error: 'Session ended', code: 'UNAUTHORIZED' };
    expect(await optionalDriverId(requestWith({ type: 'driver', driverId: 'drv_1', sv: 0 }))).toBe(
      null,
    );
  });

  it('treats a missing or invalid token as anonymous', async () => {
    expect(await optionalDriverId(requestWith(null))).toBe(null);
  });
});
