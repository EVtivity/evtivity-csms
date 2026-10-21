// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  deviceIdFromRequest,
  isMobileClient,
  isMobileSession,
  issuedDriverClient,
} from '../lib/driver-session.js';

function req(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('isMobileClient', () => {
  it('is true only for X-Client: mobile', () => {
    expect(isMobileClient(req({ 'x-client': 'mobile' }))).toBe(true);
  });
  it('is false when the header is absent', () => {
    expect(isMobileClient(req({}))).toBe(false);
  });
  it('is false for any other value', () => {
    expect(isMobileClient(req({ 'x-client': 'web' }))).toBe(false);
  });
});

describe('issuedDriverClient and isMobileSession', () => {
  function signedIn(
    source: 'bearer' | 'cookie',
    user: Record<string, unknown>,
    headers: Record<string, string | undefined> = {},
  ): FastifyRequest {
    return { headers, driverAuthSource: source, user } as unknown as FastifyRequest;
  }

  it('issues a mobile claim to a mobile sign-in', () => {
    const request = {
      headers: { 'x-client': 'mobile' },
      driverAuthSource: null,
    } as unknown as FastifyRequest;
    expect(issuedDriverClient(request)).toBe('mobile');
  });

  it('issues no claim to a portal sign-in', () => {
    const request = { headers: {}, driverAuthSource: null } as unknown as FastifyRequest;
    expect(issuedDriverClient(request)).toBeNull();
  });

  it('keeps the claim of the token the request signed in with, whatever the header says', () => {
    const cookie = signedIn('cookie', { driverId: 'd', type: 'driver' }, { 'x-client': 'mobile' });
    expect(issuedDriverClient(cookie)).toBeNull();
    const app = signedIn('bearer', { driverId: 'd', type: 'driver', client: 'mobile' });
    expect(issuedDriverClient(app)).toBe('mobile');
  });

  it('is a mobile session only for a Bearer token with the mobile claim', () => {
    expect(
      isMobileSession(signedIn('bearer', { driverId: 'd', type: 'driver', client: 'mobile' })),
    ).toBe(true);
    // A portal cookie value resent as a Bearer token carries no claim.
    expect(isMobileSession(signedIn('bearer', { driverId: 'd', type: 'driver' }))).toBe(false);
    expect(
      isMobileSession(signedIn('cookie', { driverId: 'd', type: 'driver', client: 'mobile' })),
    ).toBe(false);
  });
});

describe('deviceIdFromRequest', () => {
  it('returns the trimmed device id', () => {
    expect(deviceIdFromRequest(req({ 'x-device-id': '  dev-1  ' }))).toBe('dev-1');
  });
  it('returns undefined when absent', () => {
    expect(deviceIdFromRequest(req({}))).toBeUndefined();
  });
  it('returns undefined for an empty or whitespace value', () => {
    expect(deviceIdFromRequest(req({ 'x-device-id': '   ' }))).toBeUndefined();
  });
  it('caps the device id at 64 characters', () => {
    const long = 'a'.repeat(100);
    expect(deviceIdFromRequest(req({ 'x-device-id': long }))?.length).toBe(64);
  });
});
