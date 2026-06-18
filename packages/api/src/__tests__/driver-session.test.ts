// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { isMobileClient, deviceIdFromRequest } from '../lib/driver-session.js';

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
