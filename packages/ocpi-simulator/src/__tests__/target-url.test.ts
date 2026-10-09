// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { rewriteTargetUrl } from '../target-url.js';

describe('rewriteTargetUrl (finding JB-7)', () => {
  it('calls an advertised localhost URL through the target origin', () => {
    expect(rewriteTargetUrl('http://localhost:7104/ocpi/2.2.1', 'http://ocpi:7104')).toBe(
      'http://ocpi:7104/ocpi/2.2.1',
    );
  });

  it('keeps the path and query and takes the scheme and port of the origin', () => {
    expect(
      rewriteTargetUrl(
        'https://csms.example.com/ocpi/2.2.1/cpo/locations?limit=10',
        'http://ocpi:7104',
      ),
    ).toBe('http://ocpi:7104/ocpi/2.2.1/cpo/locations?limit=10');
  });

  it('leaves the URL as given without a target origin', () => {
    expect(rewriteTargetUrl('http://localhost:7104/ocpi/versions', undefined)).toBe(
      'http://localhost:7104/ocpi/versions',
    );
    expect(rewriteTargetUrl('http://localhost:7104/ocpi/versions', '')).toBe(
      'http://localhost:7104/ocpi/versions',
    );
  });
});
