// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { serializeRequestForLog } from '../request-log.js';

describe('serializeRequestForLog', () => {
  it('logs the path without the query string, and the route once routed', () => {
    expect(
      serializeRequestForLog({
        method: 'GET',
        url: '/ocpi/2.2.1/emsp/tokens?date_from=2026-01-01&secret=x',
        routeOptions: { url: '/ocpi/2.2.1/emsp/tokens' },
        hostname: 'ocpi.example.com',
        ip: '203.0.113.9',
      }),
    ).toEqual({
      method: 'GET',
      url: '/ocpi/2.2.1/emsp/tokens',
      route: '/ocpi/2.2.1/emsp/tokens',
      hostname: 'ocpi.example.com',
      remoteAddress: '203.0.113.9',
    });
  });

  it('logs no route before routing', () => {
    expect(
      serializeRequestForLog({
        method: 'POST',
        url: '/nowhere?token=abc',
        hostname: 'h',
        ip: '198.51.100.1',
      }),
    ).toEqual({ method: 'POST', url: '/nowhere', hostname: 'h', remoteAddress: '198.51.100.1' });
  });
});
