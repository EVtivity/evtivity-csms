// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { outboundUrl } from '../target-url.js';

describe('outboundUrl with a target origin (finding JB-7)', () => {
  const env = { OCPI_SIM_TARGET_ORIGIN: 'http://ocpi:7104' };

  it('calls an advertised localhost URL through the target origin', () => {
    expect(outboundUrl('http://localhost:7104/ocpi/2.2.1', env)).toBe(
      'http://ocpi:7104/ocpi/2.2.1',
    );
  });

  it('keeps the path and query and takes the scheme and port of the origin', () => {
    expect(outboundUrl('https://csms.example.com/ocpi/2.2.1/cpo/locations?limit=10', env)).toBe(
      'http://ocpi:7104/ocpi/2.2.1/cpo/locations?limit=10',
    );
  });

  it('never leaves the target origin, whatever host the URL names', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://internal.example.com#@ocpi:7104/',
      'http://localhost:7104//evil.example.com/x',
    ]) {
      expect(new URL(outboundUrl(url, env)).origin).toBe('http://ocpi:7104');
    }
  });
});

describe('outboundUrl without a target origin', () => {
  const env = { OCPI_TARGET_URL: 'http://localhost:7104' };

  it('calls a URL on the OCPI_TARGET_URL origin as given', () => {
    expect(outboundUrl('http://localhost:7104/ocpi/versions', env)).toBe(
      'http://localhost:7104/ocpi/versions',
    );
  });

  it('refuses another host, scheme or credentials', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:7105/ocpi/versions',
      'https://localhost:7104/ocpi/versions',
      'file:///etc/passwd',
      'http://user:pass@localhost:7104/ocpi/versions',
      'not a url',
    ]) {
      expect(() => outboundUrl(url, env)).toThrow();
    }
  });

  it('refuses every URL when no target is configured', () => {
    expect(() => outboundUrl('http://localhost:7104/ocpi/versions', {})).toThrow(
      /configured target/,
    );
    expect(() =>
      outboundUrl('http://localhost:7104/ocpi/versions', { OCPI_SIM_TARGET_ORIGIN: ' ' }),
    ).toThrow(/configured target/);
  });

  it('refuses a target setting that is not an http or https URL', () => {
    expect(() =>
      outboundUrl('http://localhost:7104/x', { OCPI_SIM_TARGET_ORIGIN: 'file:///tmp' }),
    ).toThrow(/OCPI_SIM_TARGET_ORIGIN/);
    expect(() =>
      outboundUrl('http://localhost:7104/x', { OCPI_TARGET_URL: 'http://u:p@localhost:7104' }),
    ).toThrow(/OCPI_TARGET_URL/);
  });
});
