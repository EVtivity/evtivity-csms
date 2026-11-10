// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { CSMS_VERSION_URL, parseReleasedCsmsVersion } from '../csms-update-check.js';

describe('parseReleasedCsmsVersion', () => {
  it('reads a stable version with or without the v and around whitespace', () => {
    expect(parseReleasedCsmsVersion('v0.1.50\n')).toBe('0.1.50');
    expect(parseReleasedCsmsVersion('  1.2.3 ')).toBe('1.2.3');
    expect(parseReleasedCsmsVersion('v10.0.0')).toBe('10.0.0');
  });

  it('refuses a prerelease, build metadata, markup and anything that is not one version', () => {
    for (const text of [
      '',
      'v0.1.50-beta.1',
      'v0.1.50+build',
      '0.1',
      '01.1.1',
      '<html>v0.1.50</html>',
      'v0.1.50\nv0.1.51',
      'v1.2.3.4',
      'v1234567.0.0',
      'latest',
    ]) {
      expect(parseReleasedCsmsVersion(text), text).toBeNull();
    }
  });

  it('reads the version file of the EVtivity website over HTTPS', () => {
    expect(new URL(CSMS_VERSION_URL).protocol).toBe('https:');
    expect(new URL(CSMS_VERSION_URL).hostname).toBe('evtivity.com');
  });
});
