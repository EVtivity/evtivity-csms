// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { hasAmbiguousPathEncoding } from '../request-path.js';

describe('hasAmbiguousPathEncoding', () => {
  it.each([
    '/v1/%70ortal/driver/profile',
    '/%761/users/me',
    '/v1/portal%2Fdriver/profile',
    '/v1/portal/%2e%2e/users',
    '/v1/a%5Cb',
    '/v1/stations/%7Eid',
    '/v1/stations/%5Fid',
    '/v1/stations/%2Did',
  ])('refuses %s', (url) => {
    expect(hasAmbiguousPathEncoding(url)).toBe(true);
  });

  it.each([
    '/v1/portal/driver/profile',
    '/v1/portal/chargers/CS%20001',
    '/v1/portal/chargers/CS%3A001',
    '/v1/portal/chargers/%E2%82%AC',
    '/v1/stations?search=%70ortal',
    '/v1/stations/%25',
  ])('allows %s', (url) => {
    expect(hasAmbiguousPathEncoding(url)).toBe(false);
  });
});
